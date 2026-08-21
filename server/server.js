import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { tavily } from '@tavily/core'
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())

const server = http.createServer(app)

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const tvly = tavily({
  apiKey: process.env.TAVILY_API_KEY,
})

const wss = new WebSocketServer({
  server,
  path: '/audio',
})

// ==================================================
// PERSISTENT ACCOUNT RESEARCH CACHE
// ==================================================

const DATA_DIR = path.join(__dirname, 'data')
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json')

const ACCOUNT_CACHE_MAX_AGE_MS =
  24 * 60 * 60 * 1000

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return {
        accounts: {},
      }
    }

    const parsed = JSON.parse(
      fs.readFileSync(MEMORY_FILE, 'utf8'),
    )

    return {
      accounts: parsed.accounts || {},
    }
  } catch (error) {
    console.error('Memory load error:', error)

    return {
      accounts: {},
    }
  }
}

let persistentMemory = loadMemory()

function saveMemory() {
  try {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify(
        {
          accounts: persistentMemory.accounts,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error('Memory save error:', error)
  }
}

function cleanJson(raw) {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function extractText(response) {
  return response.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
    .trim()
}

// ==================================================
// HTTP ROUTES
// ==================================================

app.get('/', (req, res) => {
  res.send('G2 Copilot v2 running')
})

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
  })
})

// ==================================================
// NEW APP CONNECTION = NEW SESSION
// ==================================================

wss.on('connection', g2Socket => {
  console.log('\n==============================')
  console.log('NEW G2 COPILOT SESSION')
  console.log('Conversation reset')
  console.log('==============================\n')

  let conversation = []
  let recentCards = []

  let mode = 'SALES'

  let analyzing = false

  let transcriptRevision = 0
  let analyzedRevision = 0

  let lastCardAt = 0

  let manualAskActive = false
  let manualAskBuffer = []
  let manualAskTimer = null

  const CARD_COOLDOWN_MS = 12000
  const MIN_RELEVANCE = 7

  const MAX_CONVERSATION_ITEMS = 50
  const MAX_RECENT_CARDS = 14

  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
  })

  const deepgramSocket = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    },
  )

  deepgramSocket.on('open', () => {
    console.log('Deepgram connected')
  })

  async function detectCompany(context) {
    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 180,

        system: `
You identify the company or organization most relevant to the CURRENT live conversation.

Do not use assumptions from any previous session.

Return ONLY valid JSON.

If no clear organization is relevant:

{
  "company": "",
  "confidence": 0
}

If one is clear:

{
  "company": "Company Name",
  "confidence": 9
}

Prefer the company relevant to the newest part of the conversation.

No markdown.
`,

        messages: [
          {
            role: 'user',
            content: context,
          },
        ],
      })

    const raw = extractText(response)

    try {
      const parsed = JSON.parse(cleanJson(raw))

      return {
        company: String(
          parsed.company || '',
        ).trim(),

        confidence: Number(
          parsed.confidence || 0,
        ),
      }
    } catch {
      console.log(
        'Company detection parse failed:',
        raw,
      )

      return {
        company: '',
        confidence: 0,
      }
    }
  }

  function accountCacheFresh(account) {
    if (!account?.researchedAt) {
      return false
    }

    const researchedAt =
      new Date(
        account.researchedAt,
      ).getTime()

    if (Number.isNaN(researchedAt)) {
      return false
    }

    return (
      Date.now() - researchedAt <
      ACCOUNT_CACHE_MAX_AGE_MS
    )
  }

  async function shouldForceRefresh(
    company,
    context,
  ) {
    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 120,

        system: `
Decide whether CURRENT web research is needed for this company conversation.

Force fresh research when the user needs information that may have changed recently, including:
- recent news
- acquisitions
- executive changes
- security incidents
- earnings
- current partnerships
- product announcements
- layoffs
- current pricing
- licensing changes
- current strategy

Return ONLY:

{
  "refresh": true
}

or

{
  "refresh": false
}

No markdown.
`,

        messages: [
          {
            role: 'user',
            content: `
COMPANY:
${company}

CONVERSATION:
${context}
`,
          },
        ],
      })

    try {
      const parsed =
        JSON.parse(
          cleanJson(
            extractText(response),
          ),
        )

      return parsed.refresh === true
    } catch {
      return false
    }
  }

  async function researchAccount(company) {
    console.log(
      'Researching account:',
      company,
    )

    const query =
      `${company} latest news executives technology strategy AI cloud cybersecurity partnerships acquisitions financial priorities 2026`

    const result =
      await tvly.search(
        query,
        {
          searchDepth: 'basic',
          maxResults: 6,
          includeAnswer: true,
        },
      )

    const resultText = (
      result.results || []
    )
      .slice(0, 6)
      .map(
        (
          item,
          index,
        ) => {
          return [
            `SOURCE ${index + 1}`,
            `Title: ${item.title || ''}`,
            `URL: ${item.url || ''}`,
            `Content: ${item.content || ''}`,
          ].join('\n')
        },
      )
      .join('\n\n')

    const research = `
ACCOUNT:
${company}

SUMMARY:
${result.answer || 'None'}

SOURCES:
${resultText || 'No results'}
`

    persistentMemory.accounts[
      company.toLowerCase()
    ] = {
      company,
      researchedAt:
        new Date().toISOString(),
      research,
    }

    saveMemory()

    return research
  }

  async function getAccountIntel(
    company,
    context,
  ) {
    if (!company) {
      return 'No account intelligence available.'
    }

    const key =
      company.toLowerCase()

    const cached =
      persistentMemory.accounts[
        key
      ]

    let forceRefresh =
      false

    if (cached) {
      forceRefresh =
        await shouldForceRefresh(
          company,
          context,
        )
    }

    if (
      cached &&
      accountCacheFresh(
        cached,
      ) &&
      !forceRefresh
    ) {
      console.log(
        'Using fresh cached account research:',
        company,
      )

      return cached.research
    }

    if (
      cached &&
      !accountCacheFresh(
        cached,
      )
    ) {
      console.log(
        'Account cache expired:',
        company,
      )
    }

    if (forceRefresh) {
      console.log(
        'Conversation requires fresh research:',
        company,
      )
    }

    try {
      return await researchAccount(
        company,
      )
    } catch (error) {
      console.error(
        'Account research error:',
        error,
      )

      if (cached) {
        return cached.research
      }

      return 'Account research unavailable.'
    }
  }

  function modeInstructions() {
    if (mode === 'GENERAL') {
      return `
MODE: GENERAL

Help during everyday conversation.

Prioritize:
- useful facts
- definitions
- corrections
- context
- names
- places
- products
- concise things to say
- helpful follow-up questions

Avoid sales framing unless the conversation itself is about business.
`
    }

    if (mode === 'MEETING') {
      return `
MODE: MEETING

Act as a live meeting copilot.

Prioritize:
- unresolved questions
- commitments
- decisions
- risks
- contradictions
- next steps
- useful clarifications
- concise responses
- missing information
`
    }

    if (mode === 'SCHOOL') {
      return `
MODE: SCHOOL

Act as an academic conversation copilot.

Prioritize:
- definitions
- concepts
- concise explanations
- factual corrections
- examples
- useful questions to ask
- connections between concepts
`
    }

    return `
MODE: SALES

Act as an elite technology account executive copilot.

Prioritize:
- buying signals
- discovery
- objections
- competitor positioning
- next-best action
- cloud
- cybersecurity
- AI
- Microsoft licensing
- software
- infrastructure
- hardware
- data
- renewals
- budget
- timeline
- pain points
- decision makers
- procurement
- vendor dissatisfaction
- security concerns
- staffing gaps
- modernization

Identify:
- why now
- who cares
- who pays
- who decides
- what happens if they do nothing
- likely objection
- likely competitor
- next-best action
`
  }

  async function generateCard(
    context,
    company,
    accountContext,
  ) {
    const priorCards =
      recentCards.length > 0
        ? recentCards
            .map(card => {
              if (card.type === 'QUESTIONS') {
                return (
                  'QUESTIONS: ' +
                  (card.questions || []).join(' | ')
                )
              }

              return `${card.type}: ${card.body || ''}`
            })
            .join('\n')
        : 'None'

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 500,

        system: `
You are the intelligence layer for smart glasses.

You listen passively to a CURRENT live conversation.

Do NOT respond to everything.

Only interrupt when something is genuinely useful right now.

${modeInstructions()}

Choose exactly ONE output:

SAY_THIS
QUESTIONS
KNOW_THIS
NO_INSIGHT

SAY_THIS:
Maximum 22 words.

QUESTIONS:
Give 2 or 3 questions.
Each question maximum 13 words.

KNOW_THIS:
Maximum 25 words.

NO_INSIGHT:
{
  "type": "NO_INSIGHT",
  "relevance": 0
}

RULES

- Relevance must be 7+ to interrupt.
- Do not combine questions and facts.
- Do not repeat cards already shown.
- Make content readable in 1-3 seconds.
- Account research may be used when relevant.
- Never dump research results.
- Return ONLY valid JSON.
- No markdown.
- No explanation.
`,

        messages: [
          {
            role: 'user',
            content: `
CURRENT CONVERSATION:

${context}

CURRENT COMPANY:

${company || 'None'}

CURRENT ACCOUNT RESEARCH:

${accountContext}

CARDS ALREADY SHOWN:

${priorCards}

Return the single most useful HUD card now.
`,
          },
        ],
      })

    const raw =
      extractText(response)

    console.log(
      'CLAUDE RAW:',
      raw,
    )

    try {
      return JSON.parse(
        cleanJson(raw),
      )
    } catch {
      console.error(
        'Card parse failed:',
        raw,
      )

      return null
    }
  }

  async function answerManualAsk(question) {
    console.log(
      'MANUAL ASK:',
      question,
    )

    const context =
      conversation.join('\n')

    let company = ''

    let accountContext =
      'No account intelligence available.'

    try {
      const companyResult =
        await detectCompany(
          `${context}\n${question}`,
        )

      company =
        companyResult.company

      if (
        company &&
        companyResult.confidence >= 7
      ) {
        accountContext =
          await getAccountIntel(
            company,
            `${context}\n${question}`,
          )
      }
    } catch (error) {
      console.error(
        'Manual company lookup error:',
        error,
      )
    }

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 350,

        system: `
You are answering a DIRECT question asked through smart glasses.

${modeInstructions()}

Answer directly.

Use recent conversation and account research when helpful.

Maximum 55 words.

If multiple short options are useful, provide up to 3 numbered options.

Do not mention that you are an AI.
`,

        messages: [
          {
            role: 'user',
            content: `
RECENT CONVERSATION:

${context}

ACCOUNT RESEARCH:

${accountContext}

DIRECT QUESTION:

${question}
`,
          },
        ],
      })

    const answer =
      extractText(response)

    if (
      !answer ||
      g2Socket.readyState !==
        WebSocket.OPEN
    ) {
      return
    }

    g2Socket.send(
      JSON.stringify({
        type: 'manual_answer',
        text: answer,
      }),
    )

    console.log(
      'Manual answer sent',
    )
  }

  function finishManualAsk() {
    if (!manualAskActive) {
      return
    }

    if (manualAskTimer) {
      clearTimeout(manualAskTimer)
      manualAskTimer = null
    }

    const question =
      manualAskBuffer
        .join(' ')
        .trim()

    manualAskActive = false
    manualAskBuffer = []

    if (!question) {
      return
    }

    answerManualAsk(question)
  }

  function scheduleManualAskFinish() {
    if (manualAskTimer) {
      clearTimeout(manualAskTimer)
    }

    manualAskTimer =
      setTimeout(
        finishManualAsk,
        1400,
      )
  }

  function cardSignature(card) {
    if (card.type === 'QUESTIONS') {
      return (
        card.questions || []
      )
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    }

    return String(card.body || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  async function runAnalysisLoop() {
    if (
      analyzing ||
      manualAskActive
    ) {
      return
    }

    analyzing = true

    try {
      while (
        analyzedRevision <
          transcriptRevision &&
        !manualAskActive
      ) {
        const targetRevision =
          transcriptRevision

        const context =
          conversation.join('\n')

        console.log(
          `Analyzing revision ${targetRevision} in ${mode} mode`,
        )

        try {
          const companyResult =
            await detectCompany(
              context,
            )

          let accountContext =
            'No account intelligence available.'

          if (
            companyResult.company &&
            companyResult.confidence >= 7
          ) {
            accountContext =
              await getAccountIntel(
                companyResult.company,
                context,
              )
          }

          const card =
            await generateCard(
              context,
              companyResult.company,
              accountContext,
            )

          if (!card) {
            analyzedRevision =
              targetRevision

            continue
          }

          const type =
            String(
              card.type ||
                'NO_INSIGHT',
            )

          const relevance =
            Number(
              card.relevance ||
                0,
            )

          if (
            type ===
              'NO_INSIGHT' ||
            relevance <
              MIN_RELEVANCE
          ) {
            analyzedRevision =
              targetRevision

            continue
          }

          let outgoingCard =
            null

          if (type === 'QUESTIONS') {
            const questions =
              Array.isArray(
                card.questions,
              )
                ? card.questions
                    .map(question =>
                      String(question).trim(),
                    )
                    .filter(Boolean)
                    .slice(0, 3)
                : []

            if (questions.length < 2) {
              analyzedRevision =
                targetRevision

              continue
            }

            outgoingCard = {
              type: 'QUESTIONS',
              relevance,
              company:
                companyResult.company,
              questions,
            }
          } else {
            const body =
              String(
                card.body || '',
              ).trim()

            if (!body) {
              analyzedRevision =
                targetRevision

              continue
            }

            outgoingCard = {
              type,
              relevance,
              company:
                companyResult.company,
              body,
            }
          }

          const signature =
            cardSignature(
              outgoingCard,
            )

          const duplicate =
            recentCards.some(
              oldCard => {
                const oldSignature =
                  cardSignature(
                    oldCard,
                  )

                return (
                  oldSignature === signature ||
                  oldSignature.includes(signature) ||
                  signature.includes(oldSignature)
                )
              },
            )

          if (duplicate) {
            analyzedRevision =
              targetRevision

            continue
          }

          if (
            Date.now() -
              lastCardAt <
            CARD_COOLDOWN_MS
          ) {
            analyzedRevision =
              targetRevision

            continue
          }

          if (
            g2Socket.readyState ===
            WebSocket.OPEN
          ) {
            g2Socket.send(
              JSON.stringify({
                type: 'card',
                card:
                  outgoingCard,
              }),
            )

            recentCards.push(
              outgoingCard,
            )

            if (
              recentCards.length >
              MAX_RECENT_CARDS
            ) {
              recentCards =
                recentCards.slice(
                  -MAX_RECENT_CARDS,
                )
            }

            lastCardAt =
              Date.now()
          }
        } catch (error) {
          console.error(
            'Analysis error:',
            error,
          )
        }

        analyzedRevision =
          targetRevision
      }
    } finally {
      analyzing = false

      if (
        analyzedRevision <
          transcriptRevision &&
        !manualAskActive
      ) {
        runAnalysisLoop()
      }
    }
  }

  deepgramSocket.on(
    'message',
    async data => {
      try {
        const message =
          JSON.parse(
            data.toString(),
          )

        const transcript =
          message.channel
            ?.alternatives?.[0]
            ?.transcript

        if (!transcript) {
          return
        }

        console.log(
          'TRANSCRIPT:',
          transcript,
        )

        if (!message.is_final) {
          return
        }

        if (manualAskActive) {
          manualAskBuffer.push(
            transcript,
          )

          scheduleManualAskFinish()

          return
        }

        conversation.push(
          transcript,
        )

        if (
          conversation.length >
          MAX_CONVERSATION_ITEMS
        ) {
          conversation =
            conversation.slice(
              -MAX_CONVERSATION_ITEMS,
            )
        }

        transcriptRevision += 1

        runAnalysisLoop()
      } catch (error) {
        console.error(
          'Deepgram message error:',
          error,
        )
      }
    },
  )

  function handleControlMessage(
    payload,
  ) {
    if (
      payload.type ===
      'set_mode'
    ) {
      const requested =
        String(
          payload.mode ||
            '',
        ).toUpperCase()

      const allowed = [
        'SALES',
        'GENERAL',
        'MEETING',
        'SCHOOL',
      ]

      if (
        allowed.includes(
          requested,
        )
      ) {
        mode = requested

        console.log(
          'MODE:',
          mode,
        )

        g2Socket.send(
          JSON.stringify({
            type: 'mode_changed',
            mode,
          }),
        )
      }

      return
    }

    if (
      payload.type ===
      'manual_ask_start'
    ) {
      manualAskActive = true
      manualAskBuffer = []

      if (manualAskTimer) {
        clearTimeout(manualAskTimer)
      }

      return
    }

    if (
      payload.type ===
      'manual_ask_cancel'
    ) {
      manualAskActive = false
      manualAskBuffer = []

      if (manualAskTimer) {
        clearTimeout(manualAskTimer)
        manualAskTimer = null
      }

      runAnalysisLoop()
    }
  }

  g2Socket.on(
    'message',
    data => {
      if (
        typeof data === 'string'
      ) {
        try {
          handleControlMessage(
            JSON.parse(data),
          )

          return
        } catch {
          // continue
        }
      }

      if (
        Buffer.isBuffer(data)
      ) {
        const maybeText =
          data.toString('utf8')

        if (
          maybeText.startsWith(
            '{',
          )
        ) {
          try {
            handleControlMessage(
              JSON.parse(
                maybeText,
              ),
            )

            return
          } catch {
            // audio
          }
        }
      }

      if (
        deepgramSocket.readyState ===
        WebSocket.OPEN
      ) {
        deepgramSocket.send(data)
      }
    },
  )

  deepgramSocket.on(
    'error',
    error => {
      console.error(
        'Deepgram error:',
        error,
      )
    },
  )

  deepgramSocket.on(
    'close',
    () => {
      console.log(
        'Deepgram disconnected',
      )
    },
  )

  g2Socket.on(
    'close',
    () => {
      conversation = []
      recentCards = []

      if (manualAskTimer) {
        clearTimeout(manualAskTimer)
      }

      if (
        deepgramSocket.readyState ===
          WebSocket.OPEN ||
        deepgramSocket.readyState ===
          WebSocket.CONNECTING
      ) {
        deepgramSocket.close()
      }

      console.log(
        'G2 disconnected',
      )
    },
  )
})

// ==================================================
// RAILWAY PORT
// ==================================================

const PORT =
  process.env.PORT || 3001

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `G2 Copilot v2 running on port ${PORT}`,
    )
  },
)