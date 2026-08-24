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
// VERSION
// ==================================================

const VERSION = '11.0'

// ==================================================
// GOOGLE DRIVE
// ==================================================

const GOOGLE_REDIRECT_URI =
  'https://g2-copilot-production.up.railway.app/google/callback'

function createGoogleOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  )

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    })
  }

  return client
}

function createDriveClient() {
  return google.drive({
    version: 'v3',
    auth: createGoogleOAuthClient(),
  })
}

const driveFolderCache = new Map()

// ==================================================
// LOCAL STORAGE
// ==================================================

const DATA_DIR = path.join(__dirname, 'data')
const NOTES_DIR = path.join(DATA_DIR, 'notes')
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  })
}

if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, {
    recursive: true,
  })
}

// ==================================================
// MEMORY
// ==================================================

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return {
        entities: {},
        accounts: {},
      }
    }

    const parsed = JSON.parse(
      fs.readFileSync(
        MEMORY_FILE,
        'utf8',
      ),
    )

    return {
      entities:
        parsed.entities || {},

      accounts:
        parsed.accounts || {},
    }
  } catch (error) {
    console.error(
      'Memory load error:',
      error,
    )

    return {
      entities: {},
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
        persistentMemory,
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
// GLOBAL CACHES
// ==================================================

const researchCache = new Map()

const RESEARCH_CACHE_MS =
  20 * 60 * 1000

const ACCOUNT_CACHE_MS =
  6 * 60 * 60 * 1000

// ==================================================
// BASIC HELPERS
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

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s$%.+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeDriveQuery(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms),
  )
}

function clamp(
  value,
  min,
  max,
) {
  return Math.max(
    min,
    Math.min(max, value),
  )
}

function tokenSet(value) {
  return new Set(
    normalizedText(value)
      .split(' ')
      .filter(
        token =>
          token.length >= 3,
      ),
  )
}

function similarity(
  first,
  second,
) {
  const a = tokenSet(first)
  const b = tokenSet(second)

  if (
    a.size === 0 ||
    b.size === 0
  ) {
    return 0
  }

  let intersection = 0

  for (const token of a) {
    if (b.has(token)) {
      intersection += 1
    }
  }

  const union =
    new Set([...a, ...b]).size

  return intersection / union
}

// ==================================================
// TAVILY CACHE
// ==================================================

async function cachedSearch(
  query,
  {
    searchDepth = 'basic',
    maxResults = 5,
    includeAnswer = true,
    ttl = RESEARCH_CACHE_MS,
  } = {},
) {
  const key =
    `${searchDepth}:${maxResults}:${normalizedText(
      query,
    )}`

  const cached =
    researchCache.get(key)

  if (
    cached &&
    Date.now() -
      cached.createdAt <
      ttl
  ) {
    console.log(
      'RESEARCH CACHE HIT:',
      query,
    )

    return cached.data
  }

  console.log(
    'TAVILY SEARCH:',
    query,
  )

  const result =
    await tvly.search(
      query,
      {
        searchDepth,
        maxResults,
        includeAnswer,
      },
    )

  researchCache.set(
    key,
    {
      createdAt:
        Date.now(),

      data: result,
    },
  )

  return result
}

function compactResearch(
  result,
) {
  if (!result) {
    return 'None'
  }

  return `
ANSWER:
${result.answer || 'None'}

SOURCES:
${(result.results || [])
  .slice(0, 5)
  .map(item => {
    const content =
      String(
        item.content || '',
      ).slice(0, 650)

    return `${item.title || ''}: ${content}`
  })
  .join('\n')}
`
}

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    `G2 Copilot JARVIS v${VERSION} running`,
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',

    version: VERSION,

    contextBriefing: true,

    sessionReset: true,

    longConversationMemory: true,

    dynamicCardRanking: true,

    antiSpam: true,

    modeIntelligence: true,

    accountIntelligence: true,

    entityEnrichment: true,

    claimVerification: true,

    numericalIntelligence: true,

    notes: true,

    drive:
      Boolean(
        process.env
          .GOOGLE_REFRESH_TOKEN,
      ),
  })
})

// ==================================================
// GOOGLE AUTH
// ==================================================

app.get('/google/auth', (req, res) => {
  const client =
    createGoogleOAuthClient()

  const authUrl =
    client.generateAuthUrl({
      access_type: 'offline',

      prompt: 'consent',

      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
      ],
    })

  res.redirect(authUrl)
})

app.get(
  '/google/callback',
  async (req, res) => {
    try {
      const code =
        String(
          req.query.code || '',
        )

      if (!code) {
        return res
          .status(400)
          .send(
            'Missing authorization code.',
          )
      }

      const client =
        createGoogleOAuthClient()

      const { tokens } =
        await client.getToken(code)

      console.log(
        'GOOGLE OAUTH SUCCESS',
      )

      if (
        tokens.refresh_token
      ) {
        console.log(
          'New Google refresh token received.',
        )
      }

      res.send(
        'G2 Copilot Google Drive connected. You can close this page.',
      )
    } catch (error) {
      console.error(
        'Google OAuth error:',
        error,
      )

      res
        .status(500)
        .send(
          'Google authorization failed.',
        )
    }
  },
)

// ==================================================
// DRIVE
// ==================================================

async function findFolder(
  drive,
  name,
  parentId = null,
) {
  const cacheKey =
    `${parentId || 'ROOT'}::${name}`

  if (
    driveFolderCache.has(
      cacheKey,
    )
  ) {
    return driveFolderCache.get(
      cacheKey,
    )
  }

  const escapedName =
    escapeDriveQuery(name)

  const query = [
    `name = '${escapedName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false',

    parentId
      ? `'${parentId}' in parents`
      : `'root' in parents`,
  ].join(' and ')

  const result =
    await drive.files.list({
      q: query,

      fields:
        'files(id,name)',

      pageSize: 20,
    })

  const folder =
    result.data.files?.[0]

  if (!folder?.id) {
    throw new Error(
      `Drive folder not found: ${name}`,
    )
  }

  driveFolderCache.set(
    cacheKey,
    folder.id,
  )

  return folder.id
}

async function getDriveDestination(
  route,
) {
  const drive =
    createDriveClient()

  const root =
    await findFolder(
      drive,
      'G2 Copilot',
    )

  if (
    route.area ===
    'GENERAL'
  ) {
    const folder =
      await findFolder(
        drive,
        'General',
        root,
      )

    return {
      folder,

      path:
        'G2 Copilot / General',
    }
  }

  if (
    route.area ===
    'WORK'
  ) {
    const folder =
      await findFolder(
        drive,
        'Work',
        root,
      )

    return {
      folder,

      path:
        'G2 Copilot / Work',
    }
  }

  const school =
    await findFolder(
      drive,
      'School',
      root,
    )

  if (!route.course) {
    return {
      folder: school,

      path:
        'G2 Copilot / School',
    }
  }

  const course =
    await findFolder(
      drive,
      route.course,
      school,
    )

  return {
    folder: course,

    path:
      `G2 Copilot / School / ${route.course}`,
  }
}

async function createGoogleDoc(
  title,
  html,
  folderId,
) {
  const drive =
    createDriveClient()

  const result =
    await drive.files.create({
      requestBody: {
        name: title,

        mimeType:
          'application/vnd.google-apps.document',

        parents: [
          folderId,
        ],
      },

      media: {
        mimeType:
          'text/html',

        body: html,
      },

      fields:
        'id,name,webViewLink',
    })

  return result.data
}

// ==================================================
// SCHOOL CLASSIFICATION
// ==================================================

async function classifySchoolCourse(
  transcript,
) {
  const response =
    await anthropic.messages.create({
      model:
        'claude-sonnet-5',

      max_tokens: 180,

      system: `
Classify this lecture into exactly one:

STAT 340
MATH 340
LIS 462
COMP SCI 320
UNSURE

Return ONLY valid JSON.

{
  "course": "STAT 340",
  "confidence": 9
}
`,

      messages: [
        {
          role: 'user',
          content: transcript,
        },
      ],
    })

  const parsed =
    parseClaudeJson(
      extractText(response),
    )

  const allowed = [
    'STAT 340',
    'MATH 340',
    'LIS 462',
    'COMP SCI 320',
  ]

  if (
    allowed.includes(
      parsed?.course,
    ) &&
    Number(
      parsed?.confidence || 0,
    ) >= 6
  ) {
    return parsed.course
  }

  return null
}

// ==================================================
// G2 CONNECTION
// ==================================================

wss.on(
  'connection',
  g2Socket => {
    console.log(
      '\n==============================',
    )

    console.log(
      'NEW G2 JARVIS v11 SESSION',
    )

    console.log(
      '==============================\n',
    )

    // ==============================================
    // SESSION STATE
    // ==============================================

    let mode = 'SALES'

    let conversation = []

    let rollingSummary = ''

    let summarizingConversation =
      false

    let recentCards = []

    let recentClaims = []

    let recentEntities = []

    let transcriptRevision = 0

    let analyzedRevision = 0

    let analyzing = false

    let lastBundleAt = 0

    let manualAskActive = false

    let manualAskBuffer = []

    let manualAskTimer = null

    let noteTaking = false

    let noteTranscript = []

    let contextCaptureActive = false

    let contextCaptureBuffer = []

    let contextCaptureTimer = null

    let momentCounter = 0

    let sessionContext = {
      raw: '',
      summary: '',
      company: '',
      course: '',
      topic: '',
      modeHint: '',
    }

    let sessionContextIntel = ''

    let sessionModeIntel = {}

    const MIN_RELEVANCE = 7

    // ==============================================
    // SEND TO GLASSES
    // ==============================================

    function sendToG2(
      payload,
    ) {
      if (
        g2Socket.readyState !==
        WebSocket.OPEN
      ) {
        return false
      }

      g2Socket.send(
        JSON.stringify(payload),
      )

      return true
    }

    // ==============================================
    // MODE BEHAVIOR
    // ==============================================

    function modePrompt() {
      if (
        mode === 'GENERAL'
      ) {
        return `
GENERAL MODE.

Behave like a proactive everyday JARVIS.

Prioritize:
- useful facts
- people and organizations
- definitions
- products
- technology
- acronyms
- calculations
- corrections
- relevant background
- current information
- useful connections

Do not interrupt for obvious or trivial facts.
`
      }

      if (
        mode === 'MEETING'
      ) {
        return `
MEETING MODE.

Behave like a live chief of staff.

Prioritize:
- decisions
- commitments
- owners
- deadlines
- action items
- unresolved questions
- blockers
- dependencies
- risks
- contradictions
- unclear responsibilities
- next actions

Listen for what people will forget later.
`
      }

      if (
        mode === 'SCHOOL'
      ) {
        return `
SCHOOL MODE.

Behave like an elite live tutor.

Prioritize:
- concepts
- definitions
- formulas
- variable meanings
- intuition
- worked implications
- examples
- professor emphasis
- misconceptions
- connections between concepts
- likely testable material
- questions that expose understanding

Do not merely repeat what the professor just said.
Add understanding.
`
      }

      return `
SALES MODE.

Behave like an elite technology account executive copilot.

Prioritize:
- customer pain
- business initiatives
- technical environment
- cloud strategy
- cybersecurity
- AI
- data
- infrastructure
- licensing
- hardware
- incumbents
- competitors
- renewals
- budget signals
- timing signals
- stakeholders
- economic buyers
- objections
- buying signals
- opportunities
- next-best action
- high-value discovery questions

Do not generate generic sales advice.
Use the actual conversation.
`
    }

    // ==============================================
    // CONTEXT BUILDERS
    // ==============================================

    function recentConversation(
      count = 18,
    ) {
      return conversation
        .slice(-count)
        .join('\n')
    }

    function fullWorkingContext() {
      return `
SESSION SUMMARY:
${rollingSummary || 'None yet'}

RECENT LIVE CONVERSATION:
${recentConversation(22) || 'None'}
`
    }

    // ==============================================
    // SESSION RESET
    // ==============================================

    function clearLiveSessionState() {
      conversation = []

      rollingSummary = ''

      summarizingConversation =
        false

      recentCards = []

      recentClaims = []

      recentEntities = []

      transcriptRevision = 0

      analyzedRevision = 0

      analyzing = false

      lastBundleAt = 0

      momentCounter = 0

      sessionModeIntel = {}

      manualAskActive = false

      manualAskBuffer = []

      if (manualAskTimer) {
        clearTimeout(
          manualAskTimer,
        )

        manualAskTimer = null
      }

      contextCaptureActive = false

      contextCaptureBuffer = []

      if (
        contextCaptureTimer
      ) {
        clearTimeout(
          contextCaptureTimer,
        )

        contextCaptureTimer =
          null
      }

      sessionContext = {
        raw: '',
        summary: '',
        company: '',
        course: '',
        topic: '',
        modeHint: '',
      }

      sessionContextIntel = ''

      console.log(
        'LIVE SESSION STATE RESET',
      )
    }

    async function resetSession() {
      if (noteTaking) {
        await stopNotes()
      }

      clearLiveSessionState()

      sendToG2({
        type:
          'session_reset',

        mode,
      })
    }

    // ==============================================
    // DEEPGRAM
    // ==============================================

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

    // ==============================================
    // LONG-CONVERSATION MEMORY
    // ==============================================

    async function compressConversationIfNeeded() {
      if (
        summarizingConversation ||
        conversation.length < 34
      ) {
        return
      }

      summarizingConversation =
        true

      const oldItems =
        conversation.slice(
          0,
          20,
        )

      try {
        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 650,

            system: `
Maintain compressed memory for a live conversation.

${modePrompt()}

Preserve only information that may matter later.

Keep:
- people
- companies
- numbers
- goals
- pain points
- claims
- decisions
- objections
- questions
- commitments
- technical details
- formulas/concepts in school
- action items
- unresolved issues

Do not add information.

Maximum 220 words.
`,

            messages: [
              {
                role: 'user',

                content: `
EXISTING MEMORY:

${rollingSummary || 'None'}

OLDER CONVERSATION TO ABSORB:

${oldItems.join('\n')}
`,
              },
            ],
          })

        rollingSummary =
          extractText(response)

        conversation.splice(
          0,
          oldItems.length,
        )

        console.log(
          'CONVERSATION COMPRESSED',
        )
      } catch (error) {
        console.error(
          'Conversation compression error:',
          error,
        )
      } finally {
        summarizingConversation =
          false
      }
    }

    // ==============================================
    // ACCOUNT INTELLIGENCE
    // ==============================================

    function accountMemoryKey(
      company,
    ) {
      return normalizedText(
        company,
      )
    }

    async function getAccountIntel(
      company,
    ) {
      if (!company) {
        return ''
      }

      const key =
        accountMemoryKey(
          company,
        )

      const existing =
        persistentMemory.accounts[
          key
        ]

      if (
        existing &&
        Date.now() -
          Number(
            existing.updatedAt ||
              0,
          ) <
          ACCOUNT_CACHE_MS
      ) {
        console.log(
          'ACCOUNT INTEL CACHE HIT:',
          company,
        )

        return existing.text || ''
      }

      try {
        const result =
          await cachedSearch(
            `${company} latest strategy priorities AI cloud cybersecurity data technology partnerships acquisitions earnings 2026`,
            {
              searchDepth:
                'advanced',

              maxResults: 6,

              ttl:
                ACCOUNT_CACHE_MS,
            },
          )

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 750,

            system: `
Create compact account intelligence for a technology seller.

Only use supplied research.

Capture:
- company direction
- current strategic priorities
- AI/data/cloud/security signals
- major technology or partnership signals
- relevant business pressure
- useful opportunity hypotheses

Do not fabricate.

Maximum 250 words.
`,

            messages: [
              {
                role: 'user',

                content:
                  compactResearch(
                    result,
                  ),
              },
            ],
          })

        const text =
          extractText(response)

        persistentMemory.accounts[
          key
        ] = {
          company,

          text,

          updatedAt:
            Date.now(),
        }

        saveMemory()

        return text
      } catch (error) {
        console.error(
          'Account research error:',
          error,
        )

        return ''
      }
    }

    // ==============================================
    // CONTEXT PRELOAD
    // ==============================================

    async function preloadSessionIntel() {
      sessionContextIntel = ''

      if (
        sessionContext.company
      ) {
        sessionContextIntel =
          await getAccountIntel(
            sessionContext.company,
          )
      }
    }

    // ==============================================
    // CONTEXT BRIEFING
    // ==============================================

    async function generateContextBriefing() {
      if (
        !sessionContext.summary &&
        !sessionContext.company &&
        !sessionContext.course &&
        !sessionContext.topic
      ) {
        return []
      }

      try {
        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 850,

            system: `
Create a pre-conversation briefing for smart glasses.

${modePrompt()}

Allowed cards:

KNOW_THIS
QUESTIONS
SAY_THIS

Create 1-3 genuinely useful cards.

KNOW_THIS:
max 25 words.

SAY_THIS:
max 22 words.

QUESTIONS:
2-3 questions,
max 13 words each.

For Sales:
prefer account intelligence, useful discovery questions, then opening framing.

For School:
prefer concept primer, important formula/connection, then useful questions.

For Meeting:
prefer what matters, what to listen for, unresolved questions.

For General:
prefer useful background and context.

Return ONLY JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "body": "..."
    }
  ]
}
`,

            messages: [
              {
                role: 'user',

                content: `
MODE:
${mode}

CONTEXT:
${JSON.stringify(
  sessionContext,
)}

PRELOADED INTELLIGENCE:
${sessionContextIntel || 'None'}
`,
              },
            ],
          })

        const parsed =
          parseClaudeJson(
            extractText(response),
          )

        return Array.isArray(
          parsed?.cards,
        )
          ? parsed.cards
          : []
      } catch (error) {
        console.error(
          'Context briefing error:',
          error,
        )

        return []
      }
    }

    // ==============================================
    // PROCESS CONTEXT
    // ==============================================

    async function processSessionContext(
      rawContext,
    ) {
      console.log(
        'SESSION CONTEXT RAW:',
        rawContext,
      )

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 450,

          system: `
Extract session setup context.

Current selected mode:
${mode}

Known courses:

STAT 340
MATH 340
LIS 462
COMP SCI 320

Return ONLY JSON:

{
  "summary": "",
  "company": "",
  "course": "",
  "topic": "",
  "mode_hint": ""
}

Do not invent information.
`,

          messages: [
            {
              role: 'user',

              content:
                rawContext,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(response),
        )

      sessionContext = {
        raw: rawContext,

        summary:
          String(
            parsed?.summary ||
              rawContext,
          ).trim(),

        company:
          String(
            parsed?.company ||
              '',
          ).trim(),

        course:
          String(
            parsed?.course ||
              '',
          ).trim(),

        topic:
          String(
            parsed?.topic ||
              '',
          ).trim(),

        modeHint:
          String(
            parsed?.mode_hint ||
              mode,
          ).trim(),
      }

      console.log(
        'SESSION CONTEXT:',
        sessionContext,
      )

      await preloadSessionIntel()

      const briefing =
        await generateContextBriefing()

      sendToG2({
        type:
          'context_ready',

        context: {
          summary:
            sessionContext.summary,

          company:
            sessionContext.company,

          course:
            sessionContext.course,

          topic:
            sessionContext.topic,
        },

        briefing,
      })
    }

    // ==============================================
    // CONTEXT CAPTURE
    // ==============================================

    function finishContextCapture() {
      if (
        !contextCaptureActive
      ) {
        return
      }

      if (
        contextCaptureTimer
      ) {
        clearTimeout(
          contextCaptureTimer,
        )

        contextCaptureTimer =
          null
      }

      const raw =
        contextCaptureBuffer
          .join(' ')
          .trim()

      contextCaptureActive =
        false

      contextCaptureBuffer = []

      if (!raw) {
        sendToG2({
          type:
            'context_skipped',
        })

        return
      }

      processSessionContext(
        raw,
      ).catch(error => {
        console.error(
          'Context processing error:',
          error,
        )

        sendToG2({
          type:
            'context_error',

          text:
            'Could not prepare context.',
        })
      })
    }

    function scheduleContextFinish() {
      if (
        contextCaptureTimer
      ) {
        clearTimeout(
          contextCaptureTimer,
        )
      }

      contextCaptureTimer =
        setTimeout(
          finishContextCapture,
          1600,
        )
    }

    // ==============================================
    // TRIGGER ENGINE V11
    // ==============================================

    async function analyzeMoment() {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 900,

          system: `
You are the interruption/trigger engine for proactive smart glasses.

${modePrompt()}

You decide whether THIS MOMENT deserves the user's visual attention.

Signals:

PERSON
COMPANY
PRODUCT
TECHNOLOGY
ACRONYM
NUMBER
CLAIM
QUESTION
DECISION
RISK
OPPORTUNITY
BUYING_SIGNAL
OBJECTION
COMPETITOR
ACTION_ITEM
DEFINITION
CURRENT_INFO
FORMULA
CONCEPT
MISCONCEPTION
DEADLINE
STAKEHOLDER
BUDGET
RENEWAL
NO_SIGNAL

Avoid interruptions for:
- greetings
- filler
- repetition
- obvious information
- weak trivia
- information already covered

A relevance 7 means clearly useful.
8 means highly useful.
9 means important.
10 means immediate/high consequence.

Return ONLY JSON:

{
  "interrupt": true,
  "relevance": 9,
  "urgency": 8,
  "why_now": "Renewal timing creates a useful commercial implication.",
  "signals": [],
  "has_numbers": true,
  "has_claims": false,
  "has_entities": true,
  "research": false,
  "research_query": ""
}
`,

          messages: [
            {
              role: 'user',

              content: `
SESSION:
${sessionContext.summary || 'None'}

PRELOADED INTELLIGENCE:
${sessionContextIntel || 'None'}

ROLLING MEMORY:
${rollingSummary || 'None'}

LATEST CONVERSATION:
${recentConversation(12)}
`,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(response),
        )

      if (!parsed) {
        return null
      }

      return {
        interrupt:
          parsed.interrupt ===
          true,

        relevance:
          clamp(
            Number(
              parsed.relevance ||
                0,
            ),
            0,
            10,
          ),

        urgency:
          clamp(
            Number(
              parsed.urgency ||
                0,
            ),
            0,
            10,
          ),

        why_now:
          String(
            parsed.why_now || '',
          ),

        signals:
          Array.isArray(
            parsed.signals,
          )
            ? parsed.signals
            : [],

        has_numbers:
          parsed.has_numbers ===
          true,

        has_claims:
          parsed.has_claims ===
          true,

        has_entities:
          parsed.has_entities ===
          true,

        research:
          parsed.research ===
          true,

        research_query:
          String(
            parsed.research_query ||
              '',
          ),
      }
    }

    // ==============================================
    // NUMERICAL INTELLIGENCE
    // ==============================================

    async function analyzeNumbers(
      trigger,
    ) {
      if (
        !trigger?.has_numbers
      ) {
        return {
          useful: false,
        }
      }

      try {
        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 700,

            system: `
You are numerical intelligence for smart glasses.

Calculate only useful implications supported by the conversation.

Examples:

8000 × $42/month
= $336,000/month
= $4.032M/year

18% discount on $2.4M
= $432,000 savings
= $1.968M final price

In School mode, calculate useful statistical or mathematical implications when supported.

Do not invent values.

Return ONLY JSON:

{
  "useful": true,
  "relevance": 9,
  "calculations": [
    {
      "label": "",
      "expression": "",
      "result": ""
    }
  ],
  "summary": ""
}
`,

            messages: [
              {
                role: 'user',

                content:
                  fullWorkingContext(),
              },
            ],
          })

        return (
          parseClaudeJson(
            extractText(response),
          ) || {
            useful: false,
          }
        )
      } catch (error) {
        console.error(
          'Numerical intelligence error:',
          error,
        )

        return {
          useful: false,
        }
      }
    }

    // ==============================================
    // CLAIM VERIFICATION
    // ==============================================

    async function verifyClaims(
      trigger,
    ) {
      if (
        !trigger?.has_claims
      ) {
        return {
          checked: false,
          claims: [],
        }
      }

      const claims =
        trigger.signals
          .filter(
            signal =>
              signal.type ===
              'CLAIM',
          )
          .map(signal =>
            String(
              signal.text || '',
            ).trim(),
          )
          .filter(Boolean)
          .slice(0, 3)

      const unseen =
        claims.filter(claim => {
          const normalized =
            normalizedText(claim)

          return !recentClaims.includes(
            normalized,
          )
        })

      if (
        unseen.length === 0
      ) {
        return {
          checked: false,
          claims: [],
        }
      }

      try {
        const result =
          await cachedSearch(
            unseen.join(' OR '),
            {
              searchDepth:
                'advanced',

              maxResults: 6,
            },
          )

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 950,

            system: `
Verify the claims using supplied research.

Verdicts:

SUPPORTED
CONTRADICTED
MISLEADING
UNCERTAIN

Be conservative.

Return ONLY JSON:

{
  "checked": true,
  "claims": [
    {
      "claim": "",
      "verdict": "",
      "confidence": 9,
      "correction": "",
      "worth_interrupting": true
    }
  ]
}
`,

            messages: [
              {
                role: 'user',

                content: `
CLAIMS:
${JSON.stringify(unseen)}

RESEARCH:
${compactResearch(result)}
`,
              },
            ],
          })

        const parsed =
          parseClaudeJson(
            extractText(response),
          )

        recentClaims.push(
          ...unseen.map(
            normalizedText,
          ),
        )

        recentClaims =
          recentClaims.slice(-40)

        return (
          parsed || {
            checked: false,
            claims: [],
          }
        )
      } catch (error) {
        console.error(
          'Claim verification error:',
          error,
        )

        return {
          checked: false,
          claims: [],
        }
      }
    }

    // ==============================================
    // ENTITY ENRICHMENT
    // ==============================================

    async function enrichEntities(
      trigger,
    ) {
      if (
        !trigger?.has_entities
      ) {
        return {
          useful: false,
          entities: [],
        }
      }

      const entityTypes = [
        'PERSON',
        'COMPANY',
        'PRODUCT',
        'TECHNOLOGY',
        'ACRONYM',
      ]

      const candidates =
        trigger.signals
          .filter(signal =>
            entityTypes.includes(
              signal.type,
            ),
          )
          .map(signal => ({
            type:
              String(
                signal.type,
              ),

            name:
              String(
                signal.text || '',
              ).trim(),
          }))
          .filter(
            entity =>
              entity.name,
          )
          .slice(0, 4)

      const unseen =
        candidates.filter(
          entity => {
            const key =
              `${entity.type}:${normalizedText(
                entity.name,
              )}`

            return !recentEntities.includes(
              key,
            )
          },
        )

      if (
        unseen.length === 0
      ) {
        return {
          useful: false,
          entities: [],
        }
      }

      try {
        const routingResponse =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 500,

            system: `
Choose only entities worth enriching right now.

${modePrompt()}

Return ONLY JSON:

{
  "entities": [
    {
      "type": "COMPANY",
      "name": "",
      "relevance": 9,
      "research": true,
      "query": ""
    }
  ]
}
`,

            messages: [
              {
                role: 'user',

                content: `
SESSION:
${sessionContext.summary || 'None'}

RECENT CONVERSATION:
${recentConversation(12)}

ENTITIES:
${JSON.stringify(unseen)}
`,
              },
            ],
          })

        const routed =
          parseClaudeJson(
            extractText(
              routingResponse,
            ),
          )

        const selected =
          Array.isArray(
            routed?.entities,
          )
            ? routed.entities
                .filter(
                  item =>
                    Number(
                      item.relevance ||
                        0,
                    ) >= 7,
                )
                .slice(0, 3)
            : []

        const enriched = []

        for (
          const entity of
          selected
        ) {
          const memoryKey =
            `${entity.type}:${normalizedText(
              entity.name,
            )}`

          let researchText = ''

          const stored =
            persistentMemory.entities[
              memoryKey
            ]

          if (
            stored &&
            Date.now() -
              Number(
                stored.updatedAt ||
                  0,
              ) <
              ACCOUNT_CACHE_MS
          ) {
            researchText =
              stored.researchText ||
              ''
          } else if (
            entity.research &&
            entity.query
          ) {
            try {
              const result =
                await cachedSearch(
                  entity.query,
                  {
                    searchDepth:
                      'basic',

                    maxResults: 5,
                  },
                )

              researchText =
                compactResearch(
                  result,
                )
            } catch (error) {
              console.error(
                'Entity Tavily error:',
                error,
              )
            }
          }

          const response =
            await anthropic.messages.create({
              model:
                'claude-sonnet-5',

              max_tokens: 450,

              system: `
Create one useful entity insight for smart glasses.

${modePrompt()}

Maximum 35 words.
No trivia.
Do not fabricate.

Return ONLY JSON:

{
  "entity": "",
  "type": "",
  "useful": true,
  "relevance": 9,
  "summary": ""
}
`,

              messages: [
                {
                  role: 'user',

                  content: `
ENTITY:
${JSON.stringify(entity)}

CONVERSATION:
${recentConversation(12)}

RESEARCH:
${researchText || 'None'}
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

          if (
            parsed?.useful ===
              true &&
            Number(
              parsed.relevance ||
                0,
            ) >= 7
          ) {
            enriched.push(
              parsed,
            )

            persistentMemory.entities[
              memoryKey
            ] = {
              ...parsed,

              researchText,

              updatedAt:
                Date.now(),
            }

            recentEntities.push(
              memoryKey,
            )
          }
        }

        recentEntities =
          recentEntities.slice(-50)

        saveMemory()

        return {
          useful:
            enriched.length > 0,

          entities:
            enriched,
        }
      } catch (error) {
        console.error(
          'Entity enrichment error:',
          error,
        )

        return {
          useful: false,
          entities: [],
        }
      }
    }

    // ==============================================
    // LIVE RESEARCH
    // ==============================================

    async function researchSignal(
      trigger,
    ) {
      if (
        !trigger?.research ||
        !trigger
          .research_query
      ) {
        return 'None'
      }

      try {
        const result =
          await cachedSearch(
            trigger.research_query,
            {
              searchDepth:
                'basic',

              maxResults: 5,
            },
          )

        return compactResearch(
          result,
        )
      } catch (error) {
        console.error(
          'Research signal error:',
          error,
        )

        return 'Research failed.'
      }
    }

    // ==============================================
    // MODE-SPECIFIC BRAIN
    // ==============================================

    async function analyzeModeIntelligence(
      trigger,
    ) {
      try {
        let schema = ''

        if (
          mode === 'SALES'
        ) {
          schema = `
{
  "mode": "SALES",
  "pain_points": [],
  "initiatives": [],
  "technical_environment": [],
  "stakeholders": [],
  "buying_signals": [],
  "objections": [],
  "competitors": [],
  "budget_signals": [],
  "timeline_signals": [],
  "opportunity": "",
  "next_best_action": "",
  "best_questions": []
}
`
        } else if (
          mode === 'MEETING'
        ) {
          schema = `
{
  "mode": "MEETING",
  "decisions": [],
  "commitments": [],
  "owners": [],
  "deadlines": [],
  "risks": [],
  "blockers": [],
  "open_questions": [],
  "next_actions": []
}
`
        } else if (
          mode === 'SCHOOL'
        ) {
          schema = `
{
  "mode": "SCHOOL",
  "main_concept": "",
  "plain_english": "",
  "formula": "",
  "variables": [],
  "connection": "",
  "common_mistake": "",
  "likely_testable": "",
  "best_questions": []
}
`
        } else {
          schema = `
{
  "mode": "GENERAL",
  "important_context": "",
  "useful_connection": "",
  "uncertainty": "",
  "next_question": ""
}
`
        }

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 1000,

            system: `
Analyze the live moment specifically for the current mode.

${modePrompt()}

Do not create HUD cards yet.

Use only information actually supported by the session and conversation.

Return ONLY JSON matching this schema:

${schema}
`,

            messages: [
              {
                role: 'user',

                content: `
SESSION:
${sessionContext.summary || 'None'}

ACCOUNT/CONTEXT INTEL:
${sessionContextIntel || 'None'}

ROLLING MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(16)}

CURRENT TRIGGER:
${JSON.stringify(trigger)}
`,
              },
            ],
          })

        const parsed =
          parseClaudeJson(
            extractText(response),
          )

        if (parsed) {
          sessionModeIntel =
            parsed
        }

        return (
          parsed || {}
        )
      } catch (error) {
        console.error(
          'Mode intelligence error:',
          error,
        )

        return {}
      }
    }

    // ==============================================
    // CARD DUPLICATE DETECTION
    // ==============================================

    function normalizeCard(
      card,
    ) {
      if (!card) {
        return null
      }

      const relevance =
        clamp(
          Number(
            card.relevance || 0,
          ),
          0,
          10,
        )

      if (
        relevance <
        MIN_RELEVANCE
      ) {
        return null
      }

      if (
        card.type ===
        'QUESTIONS'
      ) {
        const questions =
          Array.isArray(
            card.questions,
          )
            ? card.questions
                .map(q =>
                  String(q).trim(),
                )
                .filter(Boolean)
                .slice(0, 3)
            : []

        if (
          questions.length < 2
        ) {
          return null
        }

        return {
          type:
            'QUESTIONS',

          relevance,

          urgency:
            clamp(
              Number(
                card.urgency ||
                  0,
              ),
              0,
              10,
            ),

          novelty:
            clamp(
              Number(
                card.novelty ||
                  7,
              ),
              0,
              10,
            ),

          questions,
        }
      }

      if (
        card.type ===
          'KNOW_THIS' ||
        card.type ===
          'SAY_THIS'
      ) {
        const body =
          String(
            card.body || '',
          ).trim()

        if (!body) {
          return null
        }

        return {
          type: card.type,

          relevance,

          urgency:
            clamp(
              Number(
                card.urgency ||
                  0,
              ),
              0,
              10,
            ),

          novelty:
            clamp(
              Number(
                card.novelty ||
                  7,
              ),
              0,
              10,
            ),

          body,
        }
      }

      return null
    }

    function cardText(card) {
      if (
        card.type ===
        'QUESTIONS'
      ) {
        return (
          card.questions || []
        ).join(' ')
      }

      return (
        card.body || ''
      )
    }

    function duplicatePenalty(
      card,
    ) {
      const text =
        cardText(card)

      let highest = 0

      for (
        const existing of
        recentCards.slice(-14)
      ) {
        highest =
          Math.max(
            highest,

            similarity(
              text,
              cardText(
                existing.card,
              ),
            ),
          )
      }

      return highest
    }

    function rankCards(
      candidates,
    ) {
      const scored = []

      for (
        const rawCard of
        candidates
      ) {
        const card =
          normalizeCard(
            rawCard,
          )

        if (!card) {
          continue
        }

        const duplicate =
          duplicatePenalty(
            card,
          )

        if (
          duplicate >= 0.68
        ) {
          console.log(
            'CARD DROPPED AS DUPLICATE:',
            card.type,
          )

          continue
        }

        const score =
          card.relevance * 0.55 +
          card.urgency * 0.2 +
          card.novelty * 0.25 -
          duplicate * 4

        scored.push({
          card,
          score,
        })
      }

      scored.sort(
        (a, b) =>
          b.score - a.score,
      )

      // Preserve useful card-type variety.
      const selected = []

      const seenTypes =
        new Set()

      for (
        const item of scored
      ) {
        if (
          selected.length >= 3
        ) {
          break
        }

        if (
          !seenTypes.has(
            item.card.type,
          ) ||
          selected.length === 0
        ) {
          selected.push(
            item.card,
          )

          seenTypes.add(
            item.card.type,
          )
        }
      }

      if (
        selected.length < 3
      ) {
        for (
          const item of scored
        ) {
          if (
            selected.length >=
            3
          ) {
            break
          }

          if (
            !selected.includes(
              item.card,
            )
          ) {
            selected.push(
              item.card,
            )
          }
        }
      }

      return selected
    }

    // ==============================================
    // CARD GENERATION
    // ==============================================

    async function generateCandidateCards(
      trigger,
      numericalIntel,
      verification,
      entityIntel,
      research,
      modeIntel,
    ) {
      const recentCardText =
        recentCards
          .slice(-10)
          .map(
            item =>
              `${item.card.type}: ${cardText(
                item.card,
              )}`,
          )
          .join('\n')

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 1400,

          system: `
Generate candidate HUD cards for proactive smart glasses.

${modePrompt()}

The user should feel like they have JARVIS, not a chatbot.

A useful card should do at least one:

- reveal an implication
- supply timely context
- calculate something useful
- correct an important claim
- surface a risk
- recognize a buying signal
- identify a decision/action item
- explain a difficult concept
- connect two ideas
- suggest an unusually good question
- provide a useful phrase to say

Allowed:

KNOW_THIS
QUESTIONS
SAY_THIS

Generate up to 5 CANDIDATES.
The local ranking engine will select the best 1-3.

KNOW_THIS:
max 26 words.

SAY_THIS:
max 22 words.

QUESTIONS:
2-3 questions,
max 13 words each.

Every candidate needs:

relevance: 1-10
urgency: 1-10
novelty: 1-10

Do not repeat recent cards.

Do not fabricate.

Return ONLY JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "urgency": 7,
      "novelty": 9,
      "body": ""
    }
  ]
}
`,

          messages: [
            {
              role: 'user',

              content: `
SESSION:
${JSON.stringify(
  sessionContext,
)}

PRELOADED INTELLIGENCE:
${sessionContextIntel || 'None'}

LONG-TERM CONVERSATION MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(16)}

TRIGGER:
${JSON.stringify(trigger)}

MODE INTELLIGENCE:
${JSON.stringify(modeIntel)}

ENTITY INTELLIGENCE:
${JSON.stringify(entityIntel)}

NUMERICAL INTELLIGENCE:
${JSON.stringify(numericalIntel)}

CLAIM VERIFICATION:
${JSON.stringify(verification)}

LIVE RESEARCH:
${research}

RECENT HUD CARDS:
${recentCardText || 'None'}
`,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(response),
        )

      return Array.isArray(
        parsed?.cards,
      )
        ? parsed.cards
        : []
    }

    // ==============================================
    // CARD COOLDOWN
    // ==============================================

    function cooldownForTrigger(
      trigger,
    ) {
      if (
        trigger.urgency >= 9 ||
        trigger.relevance >= 10
      ) {
        return 3500
      }

      if (
        trigger.relevance >= 9
      ) {
        return 5500
      }

      if (
        trigger.relevance >= 8
      ) {
        return 7500
      }

      return 10000
    }

    // ==============================================
    // SEND CARDS
    // ==============================================

    function sendCards(
      cards,
    ) {
      if (
        cards.length === 0
      ) {
        return
      }

      for (
        const card of cards
      ) {
        sendToG2({
          type: 'card',
          card,
        })

        recentCards.push({
          card,

          createdAt:
            Date.now(),
        })

        console.log(
          'JARVIS CARD:',
          card.type,
          cardText(card),
        )
      }

      recentCards =
        recentCards.slice(-30)

      lastBundleAt =
        Date.now()
    }

    // ==============================================
    // ANALYSIS LOOP
    // ==============================================

    async function runAnalysisLoop() {
      if (
        analyzing ||
        manualAskActive ||
        contextCaptureActive
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

          try {
            const trigger =
              await analyzeMoment()

            console.log(
              'TRIGGER:',
              JSON.stringify(
                trigger,
              ),
            )

            if (
              !trigger ||
              !trigger.interrupt ||
              trigger.relevance <
                MIN_RELEVANCE
            ) {
              analyzedRevision =
                targetRevision

              continue
            }

            const cooldown =
              cooldownForTrigger(
                trigger,
              )

            const elapsed =
              Date.now() -
              lastBundleAt

            // High-urgency moments can break cooldown.
            const canBreakCooldown =
              trigger.urgency >=
                9 ||
              trigger.relevance >=
                10

            if (
              elapsed <
                cooldown &&
              !canBreakCooldown
            ) {
              console.log(
                'CARD COOLDOWN:',
                cooldown -
                  elapsed,
              )

              analyzedRevision =
                targetRevision

              continue
            }

            const [
              numericalIntel,
              verification,
              entityIntel,
              research,
              modeIntel,
            ] =
              await Promise.all([
                analyzeNumbers(
                  trigger,
                ),

                verifyClaims(
                  trigger,
                ),

                enrichEntities(
                  trigger,
                ),

                researchSignal(
                  trigger,
                ),

                analyzeModeIntelligence(
                  trigger,
                ),
              ])

            const candidates =
              await generateCandidateCards(
                trigger,
                numericalIntel,
                verification,
                entityIntel,
                research,
                modeIntel,
              )

            const cards =
              rankCards(
                candidates,
              )

            sendCards(cards)
          } catch (error) {
            console.error(
              'JARVIS ANALYSIS ERROR:',
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
          !manualAskActive &&
          !contextCaptureActive
        ) {
          runAnalysisLoop()
        }
      }
    }

    // ==============================================
    // NOTES ROUTING
    // ==============================================

    async function determineNoteRoute(
      transcript,
    ) {
      if (
        mode === 'SCHOOL'
      ) {
        const allowed = [
          'STAT 340',
          'MATH 340',
          'LIS 462',
          'COMP SCI 320',
        ]

        if (
          allowed.includes(
            sessionContext.course,
          )
        ) {
          return {
            area: 'SCHOOL',

            course:
              sessionContext.course,
          }
        }

        const course =
          await classifySchoolCourse(
            transcript,
          )

        return {
          area: 'SCHOOL',
          course,
        }
      }

      if (
        mode === 'SALES' ||
        mode === 'MEETING'
      ) {
        return {
          area: 'WORK',
          course: null,
        }
      }

      return {
        area: 'GENERAL',
        course: null,
      }
    }

    // ==============================================
    // AI NOTES
    // ==============================================

    async function generateNotes() {
      if (
        noteTranscript.length ===
        0
      ) {
        sendToG2({
          type:
            'notes_error',

          text:
            'No speech was captured.',
        })

        return
      }

      const transcript =
        noteTranscript.join(
          '\n',
        )

      try {
        const route =
          await determineNoteRoute(
            transcript,
          )

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 6000,

            system: `
You are an expert AI live note taker.

MODE:
${mode}

SESSION:
${sessionContext.summary || 'None'}

COURSE:
${sessionContext.course || 'None'}

COMPANY:
${sessionContext.company || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

Turn the transcript into polished HTML notes.

Remove:
- filler
- repetition
- verbal clutter

Never invent facts.

Use headings, bullets, numbered lists, tables when useful, and bold emphasis.

SCHOOL NOTES:

Include when relevant:

Overview
Main Concepts
Definitions
Formulas
Variable Meanings
Step-by-Step Explanations
Examples
Professor Emphasis
Likely Testable Material
Common Mistakes
Questions
Key Takeaways

MEETING NOTES:

Executive Summary
Discussion Topics
Decisions
Action Items
Owners
Deadlines
Risks
Blockers
Open Questions
Follow-Ups

SALES NOTES:

Executive Summary
Customer Situation
Pain Points
Business Initiatives
Technical Environment
Current Vendors
Buying Signals
Opportunities
Competitors
Objections
Budget Signals
Timeline
Stakeholders
Next Steps
Follow-Up Questions

GENERAL:

Organize the material clearly by topic.

EVERY NOTE MUST END WITH:

AI SUMMARY & EXPLANATION

1. Plain-English Summary
2. What This Really Means
3. Most Important Things to Remember
4. Connections

For SCHOOL:
5. How to Study This

For SALES or MEETING:
5. What I Would Do Next

Return ONLY JSON:

{
  "title": "",
  "summary": "",
  "html": ""
}
`,

            messages: [
              {
                role: 'user',

                content: `
TRANSCRIPT:

${transcript}
`,
              },
            ],
          })

        const parsed =
          parseClaudeJson(
            extractText(response),
          )

        if (
          !parsed?.title ||
          !parsed?.html
        ) {
          throw new Error(
            'Invalid note output',
          )
        }

        const destination =
          await getDriveDestination(
            route,
          )

        const date =
          new Date()
            .toISOString()
            .slice(0, 10)

        const title =
          `${date} — ${String(
            parsed.title,
          ).trim()}`

        const doc =
          await createGoogleDoc(
            title,
            parsed.html,
            destination.folder,
          )

        console.log(
          'GOOGLE DOC SAVED:',
          title,
        )

        console.log(
          'DESTINATION:',
          destination.path,
        )

        sendToG2({
          type:
            'notes_saved',

          title:
            parsed.title,

          folder:
            destination.path,

          summary:
            parsed.summary ||
            '',

          url:
            doc.webViewLink ||
            '',
        })
      } catch (error) {
        console.error(
          'NOTE SAVE ERROR:',
          error,
        )

        sendToG2({
          type:
            'notes_error',

          text:
            'Could not save notes.',
        })
      }
    }

    function startNotes() {
      if (noteTaking) {
        return
      }

      noteTaking = true

      noteTranscript = []

      console.log(
        'NOTE TAKING STARTED',
      )

      sendToG2({
        type:
          'notes_started',
      })
    }

    async function stopNotes() {
      if (!noteTaking) {
        return
      }

      noteTaking = false

      sendToG2({
        type:
          'notes_processing',
      })

      await generateNotes()

      noteTranscript = []
    }

    // ==============================================
    // COMMANDS
    // ==============================================

    async function maybeHandleCommand(
      question,
    ) {
      const normalized =
        normalizedText(
          question,
        )

      const resetCommands = [
        'new session',
        'reset session',
        'new context',
        'reset context',
        'change context',
        'new meeting',
        'new class',
      ]

      if (
        resetCommands.some(
          command =>
            normalized.includes(
              command,
            ),
        )
      ) {
        await resetSession()

        return true
      }

      const modeAliases = {
        sales: 'SALES',
        meeting: 'MEETING',
        school: 'SCHOOL',
        general: 'GENERAL',
      }

      for (
        const [
          phrase,
          targetMode,
        ] of
        Object.entries(
          modeAliases,
        )
      ) {
        if (
          normalized.includes(
            `change mode to ${phrase}`,
          ) ||
          normalized.includes(
            `switch to ${phrase}`,
          ) ||
          normalized ===
            `${phrase} mode`
        ) {
          if (noteTaking) {
            await stopNotes()
          }

          mode =
            targetMode

          clearLiveSessionState()

          sendToG2({
            type:
              'mode_changed',

            mode,
          })

          await sleep(100)

          sendToG2({
            type:
              'session_reset',

            mode,
          })

          return true
        }
      }

      if (
        normalized ===
          'start notes' ||
        normalized.includes(
          'start taking notes',
        )
      ) {
        startNotes()

        return true
      }

      if (
        normalized ===
          'stop notes' ||
        normalized.includes(
          'stop taking notes',
        )
      ) {
        await stopNotes()

        return true
      }

      return false
    }

    // ==============================================
    // MANUAL ASK
    // ==============================================

    async function answerManualAsk(
      question,
    ) {
      console.log(
        'MANUAL ASK:',
        question,
      )

      if (
        await maybeHandleCommand(
          question,
        )
      ) {
        return
      }

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 650,

          system: `
Answer a direct smart-glasses question.

${modePrompt()}

Use all relevant session and conversation context.

Be concise.

If calculations are needed, calculate them.

If the user asks what happened earlier, use rolling conversation memory.

Maximum 90 words.
`,

          messages: [
            {
              role: 'user',

              content: `
SESSION:
${JSON.stringify(
  sessionContext,
)}

PRELOADED INTELLIGENCE:
${sessionContextIntel || 'None'}

MODE INTELLIGENCE:
${JSON.stringify(
  sessionModeIntel,
)}

ROLLING MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(20)}

QUESTION:
${question}
`,
            },
          ],
        })

      sendToG2({
        type:
          'manual_answer',

        text:
          extractText(
            response,
          ),
      })
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

      manualAskBuffer = []

      if (question) {
        answerManualAsk(
          question,
        ).catch(error => {
          console.error(
            'Manual ask error:',
            error,
          )
        })
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

    // ==============================================
    // RESTORE
    // ==============================================

    async function restoreSession(
      payload,
    ) {
      const requestedMode =
        String(
          payload.mode || '',
        ).toUpperCase()

      if (
        [
          'SALES',
          'GENERAL',
          'MEETING',
          'SCHOOL',
        ].includes(
          requestedMode,
        )
      ) {
        mode =
          requestedMode
      }

      if (
        payload.context
      ) {
        sessionContext = {
          raw:
            String(
              payload.context
                .raw || '',
            ),

          summary:
            String(
              payload.context
                .summary || '',
            ),

          company:
            String(
              payload.context
                .company || '',
            ),

          course:
            String(
              payload.context
                .course || '',
            ),

          topic:
            String(
              payload.context
                .topic || '',
            ),

          modeHint:
            mode,
        }

        await preloadSessionIntel()
      }

      sendToG2({
        type:
          'session_restored',

        mode,

        context:
          sessionContext,
      })
    }

    // ==============================================
    // TRANSCRIPTS
    // ==============================================

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

          if (
            !message.is_final
          ) {
            return
          }

          console.log(
            'TRANSCRIPT:',
            transcript,
          )

          if (
            contextCaptureActive
          ) {
            contextCaptureBuffer.push(
              transcript,
            )

            scheduleContextFinish()

            return
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

          if (noteTaking) {
            noteTranscript.push(
              transcript,
            )

            console.log(
              'NOTE CAPTURE:',
              transcript,
            )
          }

          conversation.push(
            transcript,
          )

          momentCounter += 1

          transcriptRevision += 1

          runAnalysisLoop()

          compressConversationIfNeeded()
            .catch(
              console.error,
            )
        } catch (error) {
          console.error(
            'Deepgram message error:',
            error,
          )
        }
      },
    )

    // ==============================================
    // CONTROL MESSAGES
    // ==============================================

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

        if (
          [
            'SALES',
            'GENERAL',
            'MEETING',
            'SCHOOL',
          ].includes(
            requested,
          )
        ) {
          mode =
            requested

          sendToG2({
            type:
              'mode_changed',

            mode,
          })
        }

        return
      }

      if (
        payload.type ===
        'context_start'
      ) {
        contextCaptureActive =
          true

        contextCaptureBuffer =
          []

        if (
          contextCaptureTimer
        ) {
          clearTimeout(
            contextCaptureTimer,
          )

          contextCaptureTimer =
            null
        }

        return
      }

      if (
        payload.type ===
        'context_skip'
      ) {
        contextCaptureActive =
          false

        contextCaptureBuffer =
          []

        if (
          contextCaptureTimer
        ) {
          clearTimeout(
            contextCaptureTimer,
          )

          contextCaptureTimer =
            null
        }

        sendToG2({
          type:
            'context_skipped',
        })

        return
      }

      if (
        payload.type ===
        'manual_ask_start'
      ) {
        manualAskActive =
          true

        manualAskBuffer = []

        return
      }

      if (
        payload.type ===
        'manual_ask_cancel'
      ) {
        manualAskActive =
          false

        manualAskBuffer = []

        if (
          manualAskTimer
        ) {
          clearTimeout(
            manualAskTimer,
          )

          manualAskTimer =
            null
        }

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
        stopNotes().catch(
          console.error,
        )

        return
      }

      if (
        payload.type ===
        'reset_session'
      ) {
        resetSession().catch(
          console.error,
        )

        return
      }

      if (
        payload.type ===
        'restore_session'
      ) {
        restoreSession(
          payload,
        ).catch(
          console.error,
        )
      }
    }

    // ==============================================
    // G2 SOCKET
    // ==============================================

    g2Socket.on(
      'message',
      data => {
        if (
          Buffer.isBuffer(
            data,
          )
        ) {
          const text =
            data.toString(
              'utf8',
            )

          if (
            text.startsWith(
              '{',
            )
          ) {
            try {
              handleControlMessage(
                JSON.parse(text),
              )

              return
            } catch {
              // Audio packet.
            }
          }
        }

        if (
          typeof data ===
          'string'
        ) {
          try {
            handleControlMessage(
              JSON.parse(data),
            )

            return
          } catch {
            // Ignore.
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

    // ==============================================
    // CLEANUP
    // ==============================================

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
          noteTaking = false

          generateNotes().catch(
            console.error,
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
          contextCaptureTimer
        ) {
          clearTimeout(
            contextCaptureTimer,
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
      `G2 JARVIS v${VERSION} running on port ${PORT}`,
    )
  },
)