import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { tavily } from '@tavily/core'
import { google } from 'googleapis'
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
// GOOGLE OAUTH
// ==================================================

const GOOGLE_REDIRECT_URI =
  'https://g2-copilot-production.up.railway.app/google/callback'

function createGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  )
}

// ==================================================
// STORAGE
// ==================================================

const DATA_DIR = path.join(__dirname, 'data')
const NOTES_DIR = path.join(DATA_DIR, 'notes')
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json')

const ACCOUNT_CACHE_MAX_AGE_MS =
  24 * 60 * 60 * 1000

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, { recursive: true })
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
    console.error(
      'Memory load error:',
      error,
    )

    return {
      accounts: {},
    }
  }
}

let persistentMemory =
  loadMemory()

function saveMemory() {
  try {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify(
        {
          accounts:
            persistentMemory.accounts,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error(
      'Memory save error:',
      error,
    )
  }
}

// ==================================================
// HELPERS
// ==================================================

function cleanJson(raw) {
  return String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function extractText(response) {
  return response.content
    .filter(
      item =>
        item.type === 'text',
    )
    .map(item => item.text)
    .join('\n')
    .trim()
}

function parseClaudeJson(raw) {
  const cleaned =
    cleanJson(raw)

  try {
    return JSON.parse(
      cleaned,
    )
  } catch {
    const firstBrace =
      cleaned.indexOf('{')

    const lastBrace =
      cleaned.lastIndexOf('}')

    if (
      firstBrace !== -1 &&
      lastBrace !== -1 &&
      lastBrace > firstBrace
    ) {
      try {
        return JSON.parse(
          cleaned.slice(
            firstBrace,
            lastBrace + 1,
          ),
        )
      } catch {
        return null
      }
    }

    return null
  }
}

function safeFilename(value) {
  return String(
    value || 'G2 Notes',
  )
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    'G2 Copilot + Notes + Google Drive running',
  )
})

app.get(
  '/health',
  (req, res) => {
    res.json({
      status: 'ok',
      google:
        Boolean(
          process.env
            .GOOGLE_CLIENT_ID,
        ),
    })
  },
)

app.get(
  '/notes',
  (req, res) => {
    try {
      const files =
        fs
          .readdirSync(
            NOTES_DIR,
          )
          .filter(
            file =>
              file.endsWith(
                '.md',
              ),
          )

      res.json(files)
    } catch {
      res.json([])
    }
  },
)

// ==================================================
// GOOGLE AUTH ROUTES
// ==================================================

app.get(
  '/google/auth',
  (req, res) => {
    if (
      !process.env
        .GOOGLE_CLIENT_ID ||
      !process.env
        .GOOGLE_CLIENT_SECRET
    ) {
      return res
        .status(500)
        .send(
          'Google OAuth credentials are not configured on Railway.',
        )
    }

    const oauth2Client =
      createGoogleOAuthClient()

    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type:
          'offline',

        prompt:
          'consent',

        scope: [
          'https://www.googleapis.com/auth/drive.file',
        ],
      })

    console.log(
      'Starting Google OAuth',
    )

    res.redirect(
      authUrl,
    )
  },
)

app.get(
  '/google/callback',
  async (req, res) => {
    try {
      const code =
        String(
          req.query.code ||
            '',
        )

      if (!code) {
        return res
          .status(400)
          .send(
            'Missing Google authorization code.',
          )
      }

      const oauth2Client =
        createGoogleOAuthClient()

      const { tokens } =
        await oauth2Client.getToken(
          code,
        )

      console.log(
        '\n==============================',
      )

      console.log(
        'GOOGLE OAUTH SUCCESS',
      )

      if (
        tokens.refresh_token
      ) {
        console.log(
          'GOOGLE_REFRESH_TOKEN:',
          tokens.refresh_token,
        )

        console.log(
          'Copy this refresh token into Railway as GOOGLE_REFRESH_TOKEN.',
        )
      } else {
        console.log(
          'NO GOOGLE REFRESH TOKEN RETURNED',
        )

        console.log(
          'Authorize again using /google/auth.',
        )
      }

      console.log(
        '==============================\n',
      )

      res.send(`
        <!doctype html>
        <html>
          <head>
            <title>G2 Copilot</title>
          </head>

          <body style="
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 80px auto;
            padding: 20px;
          ">
            <h1>G2 Copilot</h1>

            <h2>
              Google Drive connected successfully.
            </h2>

            <p>
              You can close this page.
            </p>

            <p>
              Return to Railway and copy the
              GOOGLE_REFRESH_TOKEN from the
              deployment logs.
            </p>
          </body>
        </html>
      `)
    } catch (error) {
      console.error(
        'Google OAuth callback error:',
        error,
      )

      res
        .status(500)
        .send(
          'Google authorization failed. Check Railway logs.',
        )
    }
  },
)

// ==================================================
// G2 SESSION
// ==================================================

wss.on(
  'connection',
  g2Socket => {
    console.log(
      '\n==============================',
    )

    console.log(
      'NEW G2 SESSION',
    )

    console.log(
      '==============================\n',
    )

    let conversation = []
    let recentCards = []

    let mode = 'SALES'

    let analyzing = false

    let transcriptRevision = 0
    let analyzedRevision = 0

    let lastCardAt = 0

    let manualAskActive =
      false

    let manualAskBuffer =
      []

    let manualAskTimer =
      null

    // ==================================================
    // NOTES STATE
    // ==================================================

    let noteTaking = false
    let noteTranscript = []
    let noteStartedAt = null

    const CARD_COOLDOWN_MS =
      12000

    const MIN_RELEVANCE =
      7

    const MAX_CONVERSATION_ITEMS =
      50

    // ==================================================
    // DEEPGRAM
    // ==================================================

    const params =
      new URLSearchParams({
        model: 'nova-3',
        encoding:
          'linear16',
        sample_rate:
          '16000',
        channels: '1',
        interim_results:
          'true',
        smart_format:
          'true',
        endpointing:
          '300',
      })

    const deepgramSocket =
      new WebSocket(
        `wss://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          headers: {
            Authorization:
              `Token ${process.env.DEEPGRAM_API_KEY}`,
          },
        },
      )

    deepgramSocket.on(
      'open',
      () => {
        console.log(
          'Deepgram connected',
        )
      },
    )

    // ==================================================
    // NOTES
    // ==================================================

    async function generateNotes() {
      if (
        noteTranscript.length ===
        0
      ) {
        console.log(
          'No note transcript captured',
        )

        if (
          g2Socket.readyState ===
          WebSocket.OPEN
        ) {
          g2Socket.send(
            JSON.stringify({
              type:
                'notes_error',

              text:
                'No speech was captured.',
            }),
          )
        }

        return
      }

      const transcript =
        noteTranscript.join(
          '\n',
        )

      console.log(
        'Generating notes from',
        noteTranscript.length,
        'transcript segments',
      )

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            3000,

          system: `
You turn a raw transcript into excellent structured notes.

CURRENT MODE:
${mode}

The notes must be easy to understand later even if the user was not taking notes during the original conversation.

SCHOOL MODE:

Prioritize:
- lecture topic
- summary
- main concepts
- definitions
- formulas
- examples
- professor emphasis
- likely testable material
- confusing points
- study questions
- key takeaways

MEETING MODE:

Prioritize:
- executive summary
- discussion topics
- decisions
- action items
- owners
- deadlines
- risks
- unresolved questions
- follow-ups
- key takeaways

SALES MODE:

Prioritize:
- customer/account
- executive summary
- customer situation
- pain points
- buying signals
- opportunities
- objections
- competitors
- decision makers
- budget
- timeline
- action items
- next steps
- follow-up questions

GENERAL MODE:

Create clean general-purpose notes organized by topic.

IMPORTANT:

Remove filler and repetition.

Organize by meaning rather than simply repeating the transcript chronologically.

Never invent facts.

Return ONLY valid JSON:

{
  "title": "Short descriptive title",
  "summary": "2-4 sentence summary",
  "markdown": "# Title\\n\\n## Summary\\n..."
}

Do not use markdown fences around the JSON.
`,

          messages: [
            {
              role: 'user',

              content: `
MODE:
${mode}

NOTE TAKING STARTED:
${noteStartedAt?.toISOString() || 'Unknown'}

TRANSCRIPT:

${transcript}
`,
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

      if (
        !parsed?.markdown
      ) {
        console.error(
          'Could not generate notes:',
          raw,
        )

        if (
          g2Socket.readyState ===
          WebSocket.OPEN
        ) {
          g2Socket.send(
            JSON.stringify({
              type:
                'notes_error',

              text:
                'Could not generate notes.',
            }),
          )
        }

        return
      }

      const title =
        String(
          parsed.title ||
            'G2 Notes',
        ).trim()

      const timestamp =
        new Date()
          .toISOString()
          .replace(
            /[:.]/g,
            '-',
          )

      const filename =
        `${timestamp}-${safeFilename(title)}.md`

      const filepath =
        path.join(
          NOTES_DIR,
          filename,
        )

      fs.writeFileSync(
        filepath,
        parsed.markdown,
        'utf8',
      )

      console.log(
        'LOCAL NOTES SAVED:',
        filepath,
      )

      console.log(
        'NOTE TITLE:',
        title,
      )

      // Google Drive upload comes next.
      // For this step we are only authorizing
      // Google and keeping local saving working.

      if (
        g2Socket.readyState ===
        WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
            type:
              'notes_saved',

            title,

            filename,

            summary:
              parsed.summary ||
              '',
          }),
        )
      }
    }

    function startNotes() {
      if (noteTaking) {
        return
      }

      noteTaking = true

      noteTranscript = []

      noteStartedAt =
        new Date()

      console.log(
        'NOTE TAKING STARTED:',
        noteStartedAt.toISOString(),
      )

      if (
        g2Socket.readyState ===
        WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
            type:
              'notes_started',
          }),
        )
      }
    }

    async function stopNotes() {
      if (!noteTaking) {
        return
      }

      noteTaking = false

      console.log(
        'NOTE TAKING STOPPED',
      )

      if (
        g2Socket.readyState ===
        WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
            type:
              'notes_processing',
          }),
        )
      }

      await generateNotes()

      noteTranscript = []

      noteStartedAt =
        null
    }

    // ==================================================
    // COMPANY DETECTION
    // ==================================================

    async function detectCompany(
      context,
    ) {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 180,

          system: `
Identify the company or organization most relevant to the CURRENT conversation.

Return ONLY valid JSON.

If there is no clear company:

{
  "company": "",
  "confidence": 0
}

If there is:

{
  "company": "Company Name",
  "confidence": 9
}

No markdown.
`,

          messages: [
            {
              role: 'user',
              content:
                context,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(
            response,
          ),
        )

      if (!parsed) {
        return {
          company: '',
          confidence: 0,
        }
      }

      return {
        company:
          String(
            parsed.company ||
              '',
          ).trim(),

        confidence:
          Number(
            parsed.confidence ||
              0,
          ),
      }
    }

    // ==================================================
    // ACCOUNT RESEARCH
    // ==================================================

    function accountCacheFresh(
      account,
    ) {
      if (
        !account?.researchedAt
      ) {
        return false
      }

      const researchedAt =
        new Date(
          account.researchedAt,
        ).getTime()

      return (
        Date.now() -
          researchedAt <
        ACCOUNT_CACHE_MAX_AGE_MS
      )
    }

    async function researchAccount(
      company,
    ) {
      console.log(
        'Researching account:',
        company,
      )

      const query =
        `${company} latest news executives AI cloud cybersecurity strategy partnerships acquisitions 2026`

      const result =
        await tvly.search(
          query,
          {
            searchDepth:
              'basic',

            maxResults:
              5,

            includeAnswer:
              true,
          },
        )

      const resultText =
        (
          result.results ||
          []
        )
          .slice(0, 5)
          .map(
            (
              item,
              index,
            ) =>
              [
                `SOURCE ${index + 1}`,
                `Title: ${item.title || ''}`,
                `Content: ${item.content || ''}`,
              ].join(
                '\n',
              ),
          )
          .join(
            '\n\n',
          )

      const research = `
ACCOUNT:
${company}

SUMMARY:
${result.answer || 'None'}

SOURCES:
${resultText}
`

      persistentMemory
        .accounts[
          company.toLowerCase()
        ] = {
        company,

        researchedAt:
          new Date()
            .toISOString(),

        research,
      }

      saveMemory()

      return research
    }

    async function getAccountIntel(
      company,
    ) {
      if (!company) {
        return 'No account intelligence.'
      }

      const key =
        company.toLowerCase()

      const cached =
        persistentMemory
          .accounts[
            key
          ]

      if (
        cached &&
        accountCacheFresh(
          cached,
        )
      ) {
        return cached.research
      }

      try {
        return await researchAccount(
          company,
        )
      } catch (error) {
        console.error(
          'Research error:',
          error,
        )

        return (
          cached?.research ||
          'No account intelligence.'
        )
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
GENERAL MODE:
Surface useful facts, context, explanations, corrections and helpful responses.
`
      }

      if (
        mode === 'MEETING'
      ) {
        return `
MEETING MODE:
Prioritize decisions, commitments, risks, unresolved questions, owners and next steps.
`
      }

      if (
        mode === 'SCHOOL'
      ) {
        return `
SCHOOL MODE:
Prioritize concepts, explanations, definitions, examples and useful questions.
`
      }

      return `
SALES MODE:

Act as an elite technology account executive copilot.

Prioritize:
- buying signals
- discovery
- objections
- cloud
- cybersecurity
- AI
- licensing
- hardware
- software
- data
- budget
- timeline
- decision makers
- renewals
- competitors
- next-best actions
`
    }

    // ==================================================
    // CARD GENERATION
    // ==================================================

    async function generateCard(
      context,
      company,
      accountContext,
    ) {
      const priorCards =
        recentCards.length
          ? recentCards
              .slice(-6)
              .map(card => {
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

                return (
                  `${card.type}: ` +
                  `${card.body || ''}`
                )
              })
              .join('\n')
          : 'None'

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            450,

          system: `
You are a proactive smart-glasses copilot.

${modeInstructions()}

Only interrupt when useful.

Choose ONE:

SAY_THIS
QUESTIONS
KNOW_THIS
NO_INSIGHT

Examples:

{
  "type": "SAY_THIS",
  "relevance": 9,
  "body": "How are you measuring success for this project?"
}

{
  "type": "QUESTIONS",
  "relevance": 9,
  "questions": [
    "Who owns the budget?",
    "What is the timeline?",
    "What happens if nothing changes?"
  ]
}

{
  "type": "KNOW_THIS",
  "relevance": 9,
  "body": "Their renewal timing creates a strong opportunity."
}

{
  "type": "NO_INSIGHT",
  "relevance": 0
}

Always include relevance.

Do not repeatedly choose QUESTIONS when another card type would be more useful.

Avoid repeating cards already shown.

Return ONLY valid JSON.
`,

          messages: [
            {
              role: 'user',

              content: `
CONVERSATION:

${context}

COMPANY:

${company || 'None'}

ACCOUNT INTELLIGENCE:

${accountContext}

RECENT CARDS:

${priorCards}
`,
            },
          ],
        })

      return parseClaudeJson(
        extractText(
          response,
        ),
      )
    }

    // ==================================================
    // ANALYSIS LOOP
    // ==================================================

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
          transcriptRevision
        ) {
          const targetRevision =
            transcriptRevision

          const context =
            conversation.join(
              '\n',
            )

          try {
            const companyResult =
              await detectCompany(
                context,
              )

            let accountContext =
              'No account intelligence.'

            if (
              companyResult.company &&
              companyResult.confidence >=
                7
            ) {
              accountContext =
                await getAccountIntel(
                  companyResult.company,
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

            if (
              !Number.isFinite(
                relevance,
              ) &&
              type !==
                'NO_INSIGHT'
            ) {
              relevance =
                MIN_RELEVANCE
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
                'CARD REJECTED: low relevance',
                relevance,
              )

              analyzedRevision =
                targetRevision

              continue
            }

            if (
              Date.now() -
                lastCardAt <
              CARD_COOLDOWN_MS
            ) {
              console.log(
                'CARD REJECTED: cooldown',
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
                questions.length >=
                2
              ) {
                outgoingCard = {
                  type,
                  relevance,

                  company:
                    companyResult.company,

                  questions,
                }
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

              if (body) {
                outgoingCard = {
                  type,
                  relevance,

                  company:
                    companyResult.company,

                  body,
                }
              }
            }

            if (
              outgoingCard &&
              g2Socket.readyState ===
                WebSocket.OPEN
            ) {
              g2Socket.send(
                JSON.stringify({
                  type:
                    'card',

                  card:
                    outgoingCard,
                }),
              )

              recentCards.push(
                outgoingCard,
              )

              if (
                recentCards.length >
                14
              ) {
                recentCards =
                  recentCards.slice(
                    -14,
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
      }
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

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            350,

          system: `
Answer the user's direct smart-glasses question.

${modeInstructions()}

Maximum 55 words.

Be direct and useful.
`,

          messages: [
            {
              role: 'user',

              content: `
CONVERSATION:

${conversation.join('\n')}

QUESTION:

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
        answer &&
        g2Socket.readyState ===
          WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
            type:
              'manual_answer',

            text:
              answer,
          }),
        )

        console.log(
          'MANUAL ANSWER SENT',
        )
      }
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
      }

      const question =
        manualAskBuffer
          .join(' ')
          .trim()

      manualAskActive =
        false

      manualAskBuffer =
        []

      if (question) {
        answerManualAsk(
          question,
        )
      }
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
    // DEEPGRAM TRANSCRIPTS
    // ==================================================

    deepgramSocket.on(
      'message',
      data => {
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

          // Notes capture independently
          if (noteTaking) {
            noteTranscript.push(
              transcript,
            )

            console.log(
              'NOTE CAPTURE:',
              transcript,
            )
          }

          if (
            manualAskActive
          ) {
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
        manualAskActive =
          true

        manualAskBuffer =
          []

        console.log(
          'MANUAL ASK STARTED',
        )

        return
      }

      if (
        payload.type ===
        'manual_ask_cancel'
      ) {
        manualAskActive =
          false

        manualAskBuffer =
          []

        console.log(
          'MANUAL ASK CANCELLED',
        )

        return
      }

      if (
        payload.type ===
        'notes_start'
      ) {
        startNotes()

        return
      }

      if (
        payload.type ===
        'notes_stop'
      ) {
        stopNotes()

        return
      }
    }

    // ==================================================
    // G2 SOCKET
    // ==================================================

    g2Socket.on(
      'message',
      data => {
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
              // Continue as audio
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

    // ==================================================
    // CLEANUP
    // ==================================================

    g2Socket.on(
      'close',
      () => {
        console.log(
          'G2 disconnected',
        )

        if (
          noteTaking &&
          noteTranscript.length >
            0
        ) {
          noteTaking =
            false

          generateNotes()
            .catch(
              error =>
                console.error(
                  'Auto-save notes error:',
                  error,
                ),
            )
        }

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
  },
)

// ==================================================
// RAILWAY
// ==================================================

const PORT =
  process.env.PORT ||
  3001

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `G2 Copilot + Notes + Google running on port ${PORT}`,
    )
  },
)