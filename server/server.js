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

const SESSION_RESEARCH_COOLDOWN_MS =
  5 * 60 * 1000

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
  return String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function extractText(response) {
  return response.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
    .trim()
}

function parseClaudeJson(raw) {
  const cleaned = cleanJson(raw)

  try {
    return JSON.parse(cleaned)
  } catch {
    // Try to recover a JSON object embedded inside extra text
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')

    if (
      firstBrace !== -1 &&
      lastBrace !== -1 &&
      lastBrace > firstBrace
    ) {
      const candidate =
        cleaned.slice(
          firstBrace,
          lastBrace + 1,
        )

      try {
        return JSON.parse(candidate)
      } catch {
        // continue to fallback
      }
    }

    return null
  }
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

  const sessionResearchTimes =
    new Map()

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

  // ==================================================
  // COMPANY DETECTION
  // ==================================================

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

    const raw =
      extractText(
        response,
      )

    const parsed =
      parseClaudeJson(
        raw,
      )

    if (!parsed) {
      console.log(
        'Company detection parse failed:',
        raw,
      )

      return {
        company: '',
        confidence: 0,
      }
    }

    return {
      company: String(
        parsed.company || '',
      ).trim(),

      confidence: Number(
        parsed.confidence || 0,
      ),
    }
  }

  // ==================================================
  // ACCOUNT RESEARCH
  // ==================================================

  function accountCacheFresh(account) {
    if (!account?.researchedAt) {
      return false
    }

    const researchedAt =
      new Date(
        account.researchedAt,
      ).getTime()

    if (
      Number.isNaN(
        researchedAt,
      )
    ) {
      return false
    }

    return (
      Date.now() -
        researchedAt <
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

Return ONLY valid JSON:

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

    const parsed =
      parseClaudeJson(
        extractText(
          response,
        ),
      )

    return (
      parsed?.refresh === true
    )
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
          searchDepth:
            'basic',
          maxResults: 6,
          includeAnswer:
            true,
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

    sessionResearchTimes.set(
      company.toLowerCase(),
      Date.now(),
    )

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

    const sessionResearchedAt =
      sessionResearchTimes.get(
        key,
      )

    if (
      sessionResearchedAt &&
      Date.now() -
        sessionResearchedAt <
        SESSION_RESEARCH_COOLDOWN_MS &&
      cached
    ) {
      console.log(
        'Using same-session account research:',
        company,
      )

      return cached.research
    }

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

      sessionResearchTimes.set(
        key,
        Date.now(),
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

  // ==================================================
  // MODE PROMPTS
  // ==================================================

  function modeInstructions() {
    if (
      mode === 'GENERAL'
    ) {
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
`
    }

    if (
      mode === 'MEETING'
    ) {
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

    if (
      mode === 'SCHOOL'
    ) {
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
`
  }

  // ==================================================
  // PASSIVE CARD GENERATOR
  // ==================================================

  async function generateCard(
    context,
    company,
    accountContext,
  ) {
    const priorCards =
      recentCards.length > 0
        ? recentCards
            .map(
              card => {
                if (
                  card.type ===
                  'QUESTIONS'
                ) {
                  return (
                    'QUESTIONS: ' +
                    (
                      card.questions ||
                      []
                    ).join(
                      ' | ',
                    )
                  )
                }

                return `${card.type}: ${card.body || ''}`
              },
            )
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

IMPORTANT:
ALWAYS include a "relevance" number from 1 to 10 for every non-NO_INSIGHT response.

SAY_THIS example:

{
  "type": "SAY_THIS",
  "relevance": 9,
  "body": "How are you securing agent access as AI use expands?"
}

QUESTIONS example:

{
  "type": "QUESTIONS",
  "relevance": 9,
  "questions": [
    "What's driving the move away from AWS now?",
    "Who owns the migration decision and budget?",
    "What's the target timeline for cutover?"
  ]
}

KNOW_THIS example:

{
  "type": "KNOW_THIS",
  "relevance": 8,
  "body": "A planned AWS-to-GCP migration signals a cloud modernization opportunity."
}

NO_INSIGHT:

{
  "type": "NO_INSIGHT",
  "relevance": 0
}

RULES:
- Relevance 7+ means worth interrupting.
- If you forget relevance, the response is invalid.
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
      extractText(
        response,
      )

    console.log(
      'CLAUDE RAW:',
      raw,
    )

    const parsed =
      parseClaudeJson(
        raw,
      )

    if (!parsed) {
      console.error(
        'Card parse failed:',
        raw,
      )

      return null
    }

    return parsed
  }

  // ==================================================
  // MANUAL ASK
  // ==================================================

  async function answerManualAsk(
    question,
  ) {
    console.log(
      'MANUAL ASK:',
      question,
    )

    const context =
      conversation.join(
        '\n',
      )

    let company =
      ''

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
        companyResult.confidence >=
          7
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

Answer the user's question directly.

Use the recent conversation and available account research when helpful.

Maximum 55 words.

If multiple short options would be useful, provide up to 3 numbered options.

Do not mention that you are an AI.
Do not explain hidden reasoning.
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
      extractText(
        response,
      )

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
      'MANUAL ANSWER SENT TO G2:',
      answer,
    )
  }

  function finishManualAsk() {
    if (
      !manualAskActive
    ) {
      return
    }

    if (
      manualAskTimer
    ) {
      clearTimeout(
        manualAskTimer,
      )

      manualAskTimer =
        null
    }

    const question =
      manualAskBuffer
        .join(' ')
        .trim()

    manualAskActive =
      false

    manualAskBuffer =
      []

    if (!question) {
      return
    }

    answerManualAsk(
      question,
    )
  }

  function scheduleManualAskFinish() {
    if (
      manualAskTimer
    ) {
      clearTimeout(
        manualAskTimer,
      )
    }

    manualAskTimer =
      setTimeout(
        finishManualAsk,
        1400,
      )
  }

  // ==================================================
  // DUPLICATE CARD HANDLING
  // ==================================================

  function cardSignature(
    card,
  ) {
    if (
      card.type ===
      'QUESTIONS'
    ) {
      return (
        card.questions ||
        []
      )
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    }

    return String(
      card.body || '',
    )
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  // ==================================================
  // PASSIVE ANALYSIS LOOP
  // ==================================================

  async function runAnalysisLoop() {
    if (
      analyzing ||
      manualAskActive
    ) {
      return
    }

    analyzing =
      true

    try {
      while (
        analyzedRevision <
          transcriptRevision &&
        !manualAskActive
      ) {
        const targetRevision =
          transcriptRevision

        const context =
          conversation.join(
            '\n',
          )

        console.log(
          `Analyzing revision ${targetRevision} in ${mode} mode`,
        )

        try {
          const companyResult =
            await detectCompany(
              context,
            )

          console.log(
            'COMPANY:',
            companyResult.company ||
              'None',
            'CONFIDENCE:',
            companyResult.confidence,
          )

          let accountContext =
            'No account intelligence available.'

          if (
            companyResult.company &&
            companyResult.confidence >=
              7
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
            console.log(
              'CARD REJECTED: parse failure',
            )

            analyzedRevision =
              targetRevision

            continue
          }

          const type =
            String(
              card.type ||
                'NO_INSIGHT',
            ).trim()

          let relevance =
            Number(
              card.relevance,
            )

          // IMPORTANT FIX:
          // Claude occasionally omits relevance even when the card is clearly useful.
          // Default valid cards to MIN_RELEVANCE rather than silently killing them.
          if (
            !Number.isFinite(
              relevance,
            ) &&
            type !==
              'NO_INSIGHT'
          ) {
            relevance =
              MIN_RELEVANCE

            console.log(
              'CARD WARNING: relevance missing; defaulting to',
              MIN_RELEVANCE,
            )
          }

          if (
            type ===
            'NO_INSIGHT'
          ) {
            console.log(
              'CARD REJECTED: NO_INSIGHT',
            )

            analyzedRevision =
              targetRevision

            continue
          }

          if (
            relevance <
            MIN_RELEVANCE
          ) {
            console.log(
              `CARD REJECTED: relevance ${relevance} below ${MIN_RELEVANCE}`,
            )

            analyzedRevision =
              targetRevision

            continue
          }

          let outgoingCard =
            null

          if (
            type ===
            'QUESTIONS'
          ) {
            const questions =
              Array.isArray(
                card.questions,
              )
                ? card.questions
                    .map(
                      question =>
                        String(
                          question,
                        ).trim(),
                    )
                    .filter(
                      Boolean,
                    )
                    .slice(
                      0,
                      3,
                    )
                : []

            if (
              questions.length <
              2
            ) {
              console.log(
                'CARD REJECTED: QUESTIONS had fewer than 2 valid questions',
              )

              analyzedRevision =
                targetRevision

              continue
            }

            outgoingCard = {
              type:
                'QUESTIONS',
              relevance,
              company:
                companyResult.company,
              questions,
            }
          } else if (
            type ===
              'SAY_THIS' ||
            type ===
              'KNOW_THIS'
          ) {
            const body =
              String(
                card.body ||
                  '',
              ).trim()

            if (!body) {
              console.log(
                `CARD REJECTED: ${type} missing body`,
              )

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
          } else {
            console.log(
              'CARD REJECTED: unknown type',
              type,
            )

            analyzedRevision =
              targetRevision

            continue
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
                  oldSignature ===
                    signature ||
                  oldSignature.includes(
                    signature,
                  ) ||
                  signature.includes(
                    oldSignature,
                  )
                )
              },
            )

          if (duplicate) {
            console.log(
              'CARD REJECTED: duplicate',
            )

            analyzedRevision =
              targetRevision

            continue
          }

          const cooldownRemaining =
            CARD_COOLDOWN_MS -
            (
              Date.now() -
              lastCardAt
            )

          if (
            cooldownRemaining >
            0
          ) {
            console.log(
              `CARD REJECTED: cooldown active (${cooldownRemaining}ms remaining)`,
            )

            analyzedRevision =
              targetRevision

            continue
          }

          if (
            g2Socket.readyState !==
            WebSocket.OPEN
          ) {
            console.log(
              'CARD REJECTED: G2 socket not open',
            )

            analyzedRevision =
              targetRevision

            continue
          }

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

          console.log(
            'CARD SENT TO G2:',
            JSON.stringify(
              outgoingCard,
            ),
          )
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
      analyzing =
        false

      if (
        analyzedRevision <
          transcriptRevision &&
        !manualAskActive
      ) {
        runAnalysisLoop()
      }
    }
  }

  // ==================================================
  // TRANSCRIPTS
  // ==================================================

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

        if (
          !message.is_final
        ) {
          return
        }

        if (
          manualAskActive
        ) {
          manualAskBuffer.push(
            transcript,
          )

          console.log(
            'MANUAL QUESTION CHUNK:',
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

        transcriptRevision +=
          1

        runAnalysisLoop()
      } catch (error) {
        console.error(
          'Deepgram message error:',
          error,
        )
      }
    },
  )

  // ==================================================
  // CONTROL MESSAGES
  // ==================================================

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
        mode =
          requested

        console.log(
          'MODE:',
          mode,
        )

        g2Socket.send(
          JSON.stringify({
            type:
              'mode_changed',
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
      console.log(
        'MANUAL ASK MODE STARTED',
      )

      manualAskActive =
        true

      manualAskBuffer =
        []

      if (
        manualAskTimer
      ) {
        clearTimeout(
          manualAskTimer,
        )
      }

      return
    }

    if (
      payload.type ===
      'manual_ask_cancel'
    ) {
      console.log(
        'MANUAL ASK CANCELLED',
      )

      manualAskActive =
        false

      manualAskBuffer =
        []

      if (
        manualAskTimer
      ) {
        clearTimeout(
          manualAskTimer,
        )

        manualAskTimer =
          null
      }

      runAnalysisLoop()
    }
  }

  // ==================================================
  // G2 SOCKET
  // ==================================================

  g2Socket.on(
    'message',
    data => {
      if (
        typeof data ===
        'string'
      ) {
        try {
          handleControlMessage(
            JSON.parse(
              data,
            ),
          )

          return
        } catch {
          // continue as audio
        }
      }

      if (
        Buffer.isBuffer(
          data,
        )
      ) {
        const maybeText =
          data.toString(
            'utf8',
          )

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
            // continue as audio
          }
        }
      }

      if (
        deepgramSocket.readyState ===
        WebSocket.OPEN
      ) {
        deepgramSocket.send(
          data,
        )
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
      conversation =
        []

      recentCards =
        []

      if (
        manualAskTimer
      ) {
        clearTimeout(
          manualAskTimer,
        )
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
  process.env.PORT ||
  3001

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `G2 Copilot v2 running on port ${PORT}`,
    )
  },
)