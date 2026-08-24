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
      refresh_token:
        process.env.GOOGLE_REFRESH_TOKEN,
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
    }
  } catch (error) {
    console.error(
      'Memory load error:',
      error,
    )

    return {
      entities: {},
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
          entities:
            persistentMemory.entities,
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

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    'G2 Copilot JARVIS v10 running',
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '10.0',
    contextBriefing: true,
    sessionReset: true,
    modeSwitching: true,
    reconnect: true,
    entityEnrichment: true,
    claimVerification: true,
    numericalIntelligence: true,
    notes: true,
    drive:
      Boolean(
        process.env.GOOGLE_REFRESH_TOKEN,
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

      if (tokens.refresh_token) {
        console.log(
          'GOOGLE_REFRESH_TOKEN:',
          tokens.refresh_token,
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
// DRIVE HELPERS
// ==================================================

async function findFolder(
  drive,
  name,
  parentId = null,
) {
  const cacheKey =
    `${parentId || 'ROOT'}::${name}`

  if (
    driveFolderCache.has(cacheKey)
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
    `trashed = false`,
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

  if (route.area === 'GENERAL') {
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

  if (route.area === 'WORK') {
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
// SCHOOL ROUTING
// ==================================================

async function classifySchoolCourse(
  transcript,
) {
  const response =
    await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 180,

      system: `
Classify this lecture into exactly one:

STAT 340
MATH 340
LIS 462
COMP SCI 320
UNSURE

Return ONLY valid JSON:

{
  "course": "STAT 340",
  "confidence": 9
}

No markdown.
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
// EACH G2 CONNECTION
// ==================================================

wss.on('connection', g2Socket => {
  console.log(
    '\n==============================',
  )

  console.log(
    'NEW G2 JARVIS v10 SESSION',
  )

  console.log(
    '==============================\n',
  )

  // ==================================================
  // STATE
  // ==================================================

  let mode = 'SALES'

  let conversation = []
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

  let sessionContext = {
    raw: '',
    summary: '',
    company: '',
    course: '',
    topic: '',
    modeHint: '',
  }

  let sessionContextIntel = ''

  const MIN_RELEVANCE = 7

  const BUNDLE_COOLDOWN_MS =
    8000

  const MAX_CONVERSATION_ITEMS =
    70

  // ==================================================
  // SAFE G2 SEND
  // ==================================================

  function sendToG2(payload) {
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

  // ==================================================
  // RESET LIVE SESSION
  // ==================================================

  function clearLiveSessionState() {
    conversation = []
    recentCards = []
    recentClaims = []
    recentEntities = []

    transcriptRevision = 0
    analyzedRevision = 0

    analyzing = false
    lastBundleAt = 0

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

    if (contextCaptureTimer) {
      clearTimeout(
        contextCaptureTimer,
      )

      contextCaptureTimer = null
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

  // ==================================================
  // DEEPGRAM
  // ==================================================

  const params =
    new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: '300',
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
  // MODE PROMPT
  // ==================================================

  function modePrompt() {
    if (mode === 'GENERAL') {
      return `
GENERAL MODE

Act like a proactive everyday JARVIS.

Prioritize:
- useful facts
- people
- companies
- products
- technologies
- acronyms
- corrections
- context
- numerical implications
- current information
- useful connections
`
    }

    if (mode === 'MEETING') {
      return `
MEETING MODE

Act like a live chief of staff.

Prioritize:
- decisions
- commitments
- owners
- deadlines
- risks
- blockers
- contradictions
- unresolved questions
- action items
- people and roles
- next steps
`
    }

    if (mode === 'SCHOOL') {
      return `
SCHOOL MODE

Act like a proactive tutor.

Prioritize:
- concepts
- definitions
- formulas
- explanations
- examples
- acronyms
- professor emphasis
- likely testable material
- misconceptions
- useful conceptual connections
`
    }

    return `
SALES MODE

Act like an elite technology account executive copilot.

Prioritize:
- customer context
- companies
- executives
- products
- competitors
- buying signals
- pain
- budget
- timeline
- renewals
- decision makers
- vendor dissatisfaction
- cloud
- cybersecurity
- AI
- licensing
- infrastructure
- hardware
- data
- objections
- opportunities
- next-best action
`
  }

  // ==================================================
  // PRELOAD CONTEXT INTELLIGENCE
  // ==================================================

  async function preloadSessionIntel() {
    sessionContextIntel = ''

    if (!sessionContext.company) {
      return
    }

    try {
      console.log(
        'PRELOADING COMPANY:',
        sessionContext.company,
      )

      const query =
        `${sessionContext.company} latest news strategy AI cloud cybersecurity technology priorities partnerships acquisitions 2026`

      const result =
        await tvly.search(
          query,
          {
            searchDepth:
              'basic',

            maxResults: 5,

            includeAnswer:
              true,
          },
        )

      sessionContextIntel = `
PRELOADED COMPANY:
${sessionContext.company}

SESSION TOPIC:
${sessionContext.topic || 'Unknown'}

CURRENT RESEARCH:
${result.answer || 'None'}

SOURCES:
${(result.results || [])
  .slice(0, 5)
  .map(
    item =>
      `${item.title || ''}: ${item.content || ''}`,
  )
  .join('\n')}
`

      console.log(
        'CONTEXT INTELLIGENCE READY',
      )
    } catch (error) {
      console.error(
        'Context preload error:',
        error,
      )
    }
  }

  // ==================================================
  // CONTEXT BRIEFING
  // ==================================================

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
          model: 'claude-sonnet-5',

          max_tokens: 800,

          system: `
You create a PRE-CONVERSATION briefing for smart glasses.

${modePrompt()}

The wearer supplied setup context before the live conversation began.

Give 1 to 3 useful cards that help BEFORE the conversation starts.

Possible cards:

KNOW_THIS
QUESTIONS
SAY_THIS

SALES:
Prefer:
1. useful account/topic context
2. 2-3 strong opening/discovery questions
3. a useful opening line only if valuable

MEETING:
Prefer:
1. what likely matters
2. unresolved questions to listen for
3. useful framing statement

SCHOOL:
Prefer:
1. concise concept primer
2. important connection/formula if relevant
3. useful questions to listen for

GENERAL:
Prefer:
1. useful context
2. helpful background
3. questions only when useful

HUD LIMITS:

KNOW_THIS:
maximum 25 words

SAY_THIS:
maximum 22 words

QUESTIONS:
2 or 3 questions
maximum 13 words each

Return ONLY valid JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "body": "..."
    }
  ]
}

Maximum 3 cards.
Do not fabricate current facts.
No markdown.
`,

          messages: [
            {
              role: 'user',

              content: `
MODE:
${mode}

SESSION CONTEXT:
${sessionContext.summary || 'None'}

COMPANY:
${sessionContext.company || 'None'}

COURSE:
${sessionContext.course || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

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
        'Briefing generation error:',
        error,
      )

      return []
    }
  }

  // ==================================================
  // PROCESS SESSION CONTEXT
  // ==================================================

  async function processSessionContext(
    rawContext,
  ) {
    console.log(
      'SESSION CONTEXT RAW:',
      rawContext,
    )

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 450,

        system: `
Extract setup context for a proactive smart-glasses assistant.

CURRENT SELECTED MODE:
${mode}

Known school courses:

STAT 340
MATH 340
LIS 462
COMP SCI 320

Examples:

"Meeting with ServiceNow about AI security."

{
  "summary": "ServiceNow meeting about AI security",
  "company": "ServiceNow",
  "course": "",
  "topic": "AI security",
  "mode_hint": "SALES"
}

"STAT 340 lecture about regression."

{
  "summary": "STAT 340 lecture about regression",
  "company": "",
  "course": "STAT 340",
  "topic": "regression",
  "mode_hint": "SCHOOL"
}

Possible mode_hint:

SALES
MEETING
SCHOOL
GENERAL

Do not invent information.

Return ONLY valid JSON.
No markdown.
`,

        messages: [
          {
            role: 'user',
            content: rawContext,
          },
        ],
      })

    const parsed =
      parseClaudeJson(
        extractText(response),
      )

    if (!parsed) {
      sessionContext = {
        raw: rawContext,
        summary: rawContext,
        company: '',
        course: '',
        topic: '',
        modeHint: mode,
      }
    } else {
      sessionContext = {
        raw: rawContext,

        summary:
          String(
            parsed.summary ||
              rawContext,
          ).trim(),

        company:
          String(
            parsed.company || '',
          ).trim(),

        course:
          String(
            parsed.course || '',
          ).trim(),

        topic:
          String(
            parsed.topic || '',
          ).trim(),

        modeHint:
          String(
            parsed.mode_hint ||
              mode,
          ).trim(),
      }
    }

    console.log(
      'SESSION CONTEXT:',
      JSON.stringify(
        sessionContext,
      ),
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

  // ==================================================
  // CONTEXT CAPTURE
  // ==================================================

  function finishContextCapture() {
    if (!contextCaptureActive) {
      return
    }

    if (contextCaptureTimer) {
      clearTimeout(
        contextCaptureTimer,
      )

      contextCaptureTimer = null
    }

    const raw =
      contextCaptureBuffer
        .join(' ')
        .trim()

    contextCaptureActive = false
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
        'Session context error:',
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
    if (contextCaptureTimer) {
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

  // ==================================================
  // TRIGGER ENGINE
  // ==================================================

  async function analyzeMoment(
    context,
  ) {
    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 900,

        system: `
You are the trigger engine for proactive smart glasses.

Do NOT create final HUD text.

${modePrompt()}

Detect:

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
NO_SIGNAL

Only interrupt when something materially useful exists.

Return ONLY valid JSON:

{
  "interrupt": true,
  "relevance": 9,
  "signals": [
    {
      "type": "COMPANY",
      "text": "Databricks"
    }
  ],
  "has_numbers": false,
  "has_claims": false,
  "has_entities": true,
  "research": false,
  "research_query": ""
}

If nothing useful:

{
  "interrupt": false,
  "relevance": 0,
  "signals": [],
  "has_numbers": false,
  "has_claims": false,
  "has_entities": false,
  "research": false,
  "research_query": ""
}

No markdown.
`,

        messages: [
          {
            role: 'user',

            content: `
SESSION SETUP:

${sessionContext.summary || 'None'}

COMPANY:
${sessionContext.company || 'None'}

COURSE:
${sessionContext.course || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

PRELOADED INTELLIGENCE:

${sessionContextIntel || 'None'}

LIVE CONVERSATION:

${context}
`,
          },
        ],
      })

    return parseClaudeJson(
      extractText(response),
    )
  }

  // ==================================================
  // ENTITY ENRICHMENT
  // ==================================================

  async function enrichEntities(
    context,
    trigger,
  ) {
    if (
      trigger?.has_entities !==
      true
    ) {
      return {
        useful: false,
        entities: [],
      }
    }

    const supportedTypes = [
      'PERSON',
      'COMPANY',
      'PRODUCT',
      'TECHNOLOGY',
      'ACRONYM',
    ]

    const entities =
      (trigger.signals || [])
        .filter(signal =>
          supportedTypes.includes(
            signal.type,
          ),
        )
        .map(signal => ({
          type:
            String(signal.type),

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

    const newEntities =
      entities.filter(entity => {
        const key =
          `${entity.type}:${normalizedText(
            entity.name,
          )}`

        return !recentEntities.includes(
          key,
        )
      })

    if (
      newEntities.length === 0
    ) {
      return {
        useful: false,
        entities: [],
      }
    }

    try {
      const routingResponse =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 550,

          system: `
Decide which entities in the current conversation deserve enrichment.

${modePrompt()}

Return ONLY valid JSON:

{
  "entities": [
    {
      "type": "COMPANY",
      "name": "Databricks",
      "relevance": 9,
      "research": true,
      "query": "Databricks latest AI data strategy 2026"
    }
  ]
}

If nothing is useful:

{
  "entities": []
}

No markdown.
`,

          messages: [
            {
              role: 'user',

              content: `
SESSION CONTEXT:

${sessionContext.summary || 'None'}

CONVERSATION:

${context}

ENTITIES:

${JSON.stringify(
  newEntities,
)}
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
                entity =>
                  Number(
                    entity.relevance ||
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
        const key =
          `${entity.type}:${normalizedText(
            entity.name,
          )}`

        let researchText =
          'No live research.'

        if (
          entity.research === true &&
          entity.query
        ) {
          try {
            const result =
              await tvly.search(
                entity.query,
                {
                  searchDepth:
                    'basic',

                  maxResults: 5,

                  includeAnswer:
                    true,
                },
              )

            researchText = `
SUMMARY:
${result.answer || 'None'}

SOURCES:
${(result.results || [])
  .slice(0, 5)
  .map(
    item =>
      `${item.title || ''}: ${item.content || ''}`,
  )
  .join('\n')}
`
          } catch (error) {
            console.error(
              'Entity research error:',
              error,
            )
          }
        }

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens: 500,

            system: `
Produce concise entity enrichment for smart glasses.

${modePrompt()}

Return ONLY valid JSON:

{
  "entity": "Databricks",
  "type": "COMPANY",
  "useful": true,
  "relevance": 9,
  "summary": "Databricks combines data engineering, analytics and AI around its lakehouse platform."
}

Max 35 words.
No trivia.
No fabricated information.
No markdown.
`,

            messages: [
              {
                role: 'user',

                content: `
SESSION CONTEXT:

${sessionContext.summary || 'None'}

CONVERSATION:

${context}

ENTITY:

${JSON.stringify(entity)}

RESEARCH:

${researchText}
`,
              },
            ],
          })

        const parsed =
          parseClaudeJson(
            extractText(response),
          )

        if (
          parsed?.useful === true &&
          Number(
            parsed.relevance || 0,
          ) >= 7 &&
          parsed.summary
        ) {
          enriched.push(parsed)

          persistentMemory.entities[
            key
          ] = {
            ...parsed,

            enrichedAt:
              new Date()
                .toISOString(),
          }

          recentEntities.push(
            key,
          )
        }
      }

      if (
        recentEntities.length > 40
      ) {
        recentEntities =
          recentEntities.slice(-40)
      }

      saveMemory()

      return {
        useful:
          enriched.length > 0,

        entities: enriched,
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

  // ==================================================
  // NUMERICAL INTELLIGENCE
  // ==================================================

  async function analyzeNumbers(
    context,
    trigger,
  ) {
    if (
      trigger?.has_numbers !==
      true
    ) {
      return {
        useful: false,
        relevance: 0,
        calculations: [],
        summary: '',
      }
    }

    try {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 700,

          system: `
You are the numerical intelligence engine for smart glasses.

Calculate only useful numerical implications supported by the conversation.

Examples:

8000 users × $42/month
= $336K/month
= $4.032M/year

18% off $2.4M
= $432K savings
= $1.968M final price

Do not invent missing values.

Return ONLY valid JSON:

{
  "useful": true,
  "relevance": 9,
  "calculations": [
    {
      "label": "Annual spend",
      "expression": "8000 × 42 × 12",
      "result": "$4.032M/year"
    }
  ],
  "summary": "8,000 users at $42/month equals about $4.03M annually."
}

If nothing useful:

{
  "useful": false,
  "relevance": 0,
  "calculations": [],
  "summary": ""
}

No markdown.
`,

          messages: [
            {
              role: 'user',

              content: `
SESSION CONTEXT:

${sessionContext.summary || 'None'}

CONVERSATION:

${context}

SIGNALS:

${JSON.stringify(
  trigger?.signals || [],
)}
`,
            },
          ],
        })

      return (
        parseClaudeJson(
          extractText(response),
        ) || {
          useful: false,
          relevance: 0,
          calculations: [],
          summary: '',
        }
      )
    } catch (error) {
      console.error(
        'Number analysis error:',
        error,
      )

      return {
        useful: false,
        relevance: 0,
        calculations: [],
        summary: '',
      }
    }
  }

  // ==================================================
  // CLAIM VERIFICATION
  // ==================================================

  async function verifyClaims(
    context,
    trigger,
  ) {
    if (
      trigger?.has_claims !==
      true
    ) {
      return {
        checked: false,
        claims: [],
      }
    }

    const claims =
      (trigger.signals || [])
        .filter(
          signal =>
            signal.type ===
            'CLAIM',
        )
        .map(
          signal =>
            String(
              signal.text || '',
            ).trim(),
        )
        .filter(Boolean)
        .slice(0, 3)

    const unseenClaims =
      claims.filter(claim => {
        const normalized =
          normalizedText(claim)

        return !recentClaims.includes(
          normalized,
        )
      })

    if (
      unseenClaims.length === 0
    ) {
      return {
        checked: false,
        claims: [],
      }
    }

    try {
      const search =
        await tvly.search(
          unseenClaims.join(
            ' OR ',
          ),
          {
            searchDepth:
              'advanced',

            maxResults: 6,

            includeAnswer:
              true,
          },
        )

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 950,

          system: `
Verify factual claims using the supplied research.

Classify:

SUPPORTED
CONTRADICTED
MISLEADING
UNCERTAIN

Be conservative.

Do not call something false simply because evidence is missing.

Return ONLY valid JSON:

{
  "checked": true,
  "claims": [
    {
      "claim": "...",
      "verdict": "CONTRADICTED",
      "confidence": 9,
      "correction": "...",
      "worth_interrupting": true
    }
  ]
}

No markdown.
`,

          messages: [
            {
              role: 'user',

              content: `
CLAIMS:

${JSON.stringify(
  unseenClaims,
)}

SEARCH ANSWER:

${search.answer || 'None'}

SOURCES:

${JSON.stringify(
  search.results || [],
)}
`,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(response),
        )

      for (
        const claim of
        unseenClaims
      ) {
        recentClaims.push(
          normalizedText(claim),
        )
      }

      if (
        recentClaims.length > 30
      ) {
        recentClaims =
          recentClaims.slice(-30)
      }

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

  // ==================================================
  // OPTIONAL RESEARCH
  // ==================================================

  async function researchSignal(
    trigger,
  ) {
    if (
      !trigger?.research ||
      !trigger?.research_query
    ) {
      return (
        'No extra live research.'
      )
    }

    try {
      const result =
        await tvly.search(
          trigger.research_query,
          {
            searchDepth:
              'basic',

            maxResults: 5,

            includeAnswer:
              true,
          },
        )

      return `
SUMMARY:
${result.answer || 'None'}

RESULTS:
${JSON.stringify(
  result.results || [],
)}
`
    } catch (error) {
      console.error(
        'Live research error:',
        error,
      )

      return (
        'Live research failed.'
      )
    }
  }

  // ==================================================
  // BUNDLE GENERATOR
  // ==================================================

  async function generateBundle(
    context,
    trigger,
    numericalIntel,
    verification,
    entityIntel,
    research,
  ) {
    const recent =
      recentCards
        .slice(-10)
        .map(card => {
          if (
            card.type ===
            'QUESTIONS'
          ) {
            return (
              'QUESTIONS: ' +
              (
                card.questions || []
              ).join(' | ')
            )
          }

          return (
            `${card.type}: ` +
            `${card.body || ''}`
          )
        })
        .join('\n')

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 1200,

        system: `
Create compact HUD card bundles.

${modePrompt()}

Use:
- session setup
- preloaded intelligence
- live conversation
- entity enrichment
- numerical intelligence
- claim verification
- live research

Return 1 to 3 cards.

Allowed:

KNOW_THIS
QUESTIONS
SAY_THIS

SALES:
Prefer KNOW_THIS → QUESTIONS → SAY_THIS

MEETING:
Prefer KNOW_THIS → QUESTIONS → SAY_THIS

SCHOOL:
Prefer KNOW_THIS explanation → KNOW_THIS connection → QUESTIONS

GENERAL:
Prefer KNOW_THIS fact/context → KNOW_THIS connection → QUESTIONS or SAY_THIS

KNOW_THIS:
maximum 25 words

SAY_THIS:
maximum 22 words

QUESTIONS:
2 or 3 questions
maximum 13 words each

If claim verification says CONTRADICTED or MISLEADING with high confidence and worth_interrupting=true, consider a neutral correction.

If numerical intelligence is useful, consider its strongest implication.

Return ONLY valid JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "body": "..."
    }
  ]
}

Minimum relevance 7.
Maximum 3 cards.
No repetition.
Do not fabricate.
No markdown.
`,

        messages: [
          {
            role: 'user',

            content: `
SESSION SETUP:

${sessionContext.summary || 'None'}

COMPANY:
${sessionContext.company || 'None'}

COURSE:
${sessionContext.course || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

PRELOADED INTELLIGENCE:

${sessionContextIntel || 'None'}

LIVE CONVERSATION:

${context}

TRIGGER:

${JSON.stringify(trigger)}

ENTITY INTELLIGENCE:

${JSON.stringify(
  entityIntel,
)}

NUMERICAL INTELLIGENCE:

${JSON.stringify(
  numericalIntel,
)}

CLAIM VERIFICATION:

${JSON.stringify(
  verification,
)}

OTHER RESEARCH:

${research}

RECENT CARDS:

${recent || 'None'}
`,
          },
        ],
      })

    return parseClaudeJson(
      extractText(response),
    )
  }

  // ==================================================
  // CARD HELPERS
  // ==================================================

  function normalizeCard(card) {
    if (!card) {
      return null
    }

    let relevance =
      Number(card.relevance)

    if (
      !Number.isFinite(relevance)
    ) {
      relevance =
        MIN_RELEVANCE
    }

    if (
      relevance <
      MIN_RELEVANCE
    ) {
      return null
    }

    if (
      card.type === 'QUESTIONS'
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
              .filter(Boolean)
              .slice(0, 3)
          : []

      if (
        questions.length < 2
      ) {
        return null
      }

      return {
        type: 'QUESTIONS',
        relevance,
        questions,
      }
    }

    if (
      card.type === 'KNOW_THIS' ||
      card.type === 'SAY_THIS'
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
        body,
      }
    }

    return null
  }

  function cardSignature(card) {
    if (
      card.type === 'QUESTIONS'
    ) {
      return normalizedText(
        (
          card.questions ||
          []
        ).join(' '),
      )
    }

    return normalizedText(
      card.body,
    )
  }

  function isDuplicateCard(card) {
    const signature =
      cardSignature(card)

    return recentCards.some(
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
  }

  function sendBundle(cards) {
    const cleanCards =
      cards
        .map(normalizeCard)
        .filter(Boolean)
        .filter(
          card =>
            !isDuplicateCard(
              card,
            ),
        )
        .slice(0, 3)

    if (
      cleanCards.length === 0
    ) {
      return
    }

    for (
      const card of
      cleanCards
    ) {
      sendToG2({
        type: 'card',
        card,
      })

      recentCards.push(card)

      console.log(
        'JARVIS CARD SENT:',
        card.type,
      )
    }

    if (
      recentCards.length > 24
    ) {
      recentCards =
        recentCards.slice(-24)
    }

    lastBundleAt =
      Date.now()
  }

  // ==================================================
  // ANALYSIS LOOP
  // ==================================================

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

        const context =
          conversation.join('\n')

        try {
          const trigger =
            await analyzeMoment(
              context,
            )

          console.log(
            'JARVIS TRIGGER:',
            JSON.stringify(
              trigger,
            ),
          )

          if (
            !trigger ||
            trigger.interrupt !== true ||
            Number(
              trigger.relevance || 0,
            ) <
              MIN_RELEVANCE
          ) {
            analyzedRevision =
              targetRevision

            continue
          }

          if (
            Date.now() -
              lastBundleAt <
            BUNDLE_COOLDOWN_MS
          ) {
            analyzedRevision =
              targetRevision

            continue
          }

          const [
            numericalIntel,
            verification,
            entityIntel,
            research,
          ] =
            await Promise.all([
              analyzeNumbers(
                context,
                trigger,
              ),

              verifyClaims(
                context,
                trigger,
              ),

              enrichEntities(
                context,
                trigger,
              ),

              researchSignal(
                trigger,
              ),
            ])

          const bundle =
            await generateBundle(
              context,
              trigger,
              numericalIntel,
              verification,
              entityIntel,
              research,
            )

          if (
            Array.isArray(
              bundle?.cards,
            )
          ) {
            sendBundle(
              bundle.cards,
            )
          }
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

  // ==================================================
  // NOTES ROUTING
  // ==================================================

  async function determineNoteRoute(
    transcript,
  ) {
    if (mode === 'SCHOOL') {
      const allowedCourses = [
        'STAT 340',
        'MATH 340',
        'LIS 462',
        'COMP SCI 320',
      ]

      if (
        allowedCourses.includes(
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

  // ==================================================
  // NOTE GENERATION
  // ==================================================

  async function generateNotes() {
    if (
      noteTranscript.length === 0
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
      noteTranscript.join('\n')

    try {
      const route =
        await determineNoteRoute(
          transcript,
        )

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 5500,

          system: `
You are an expert AI note taker.

Turn the transcript into polished, highly understandable notes.

MODE:
${mode}

SESSION CONTEXT:
${sessionContext.summary || 'None'}

COURSE:
${sessionContext.course || 'None'}

COMPANY:
${sessionContext.company || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

Remove filler and repetition.
Do not invent information.
Organize by topic.

SCHOOL:
Include:
- overview
- main concepts
- definitions
- formulas
- variable meanings
- explanations
- examples
- professor emphasis
- likely testable material
- common mistakes
- questions
- key takeaways

MEETING:
Include:
- executive summary
- discussion topics
- decisions
- action items
- owners
- deadlines
- risks
- blockers
- unresolved questions
- follow-ups

SALES:
Include:
- executive summary
- customer situation
- pain points
- technical environment
- buying signals
- opportunities
- current vendors
- competitors
- objections
- budget
- timeline
- stakeholders
- next-best actions
- follow-up questions

GENERAL:
Organize the important ideas clearly.

==================================================
MANDATORY ENDING
==================================================

EVERY NOTE MUST END WITH:

AI SUMMARY & EXPLANATION

Include:

1. Plain-English Summary
2. What This Really Means
3. Most Important Things to Remember
4. Connections

For SCHOOL:

5. How to Study This

For SALES or MEETING:

5. What I Would Do Next

Return ONLY valid JSON:

{
  "title": "Short title",
  "summary": "Short summary",
  "html": "<h1>...</h1>..."
}

No markdown fences.
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
          'Invalid AI notes output',
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
          parsed.summary || '',

        url:
          doc.webViewLink || '',
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

  // ==================================================
  // MANUAL VOICE COMMANDS
  // ==================================================

  async function maybeHandleCommand(
    question,
  ) {
    const normalized =
      normalizedText(question)

    // ----------------------------------------------
    // NEW / RESET SESSION
    // ----------------------------------------------

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
        phrase =>
          normalized.includes(
            phrase,
          ),
      )
    ) {
      console.log(
        'VOICE COMMAND: RESET SESSION',
      )

      await resetSession()

      return true
    }

    // ----------------------------------------------
    // CHANGE MODE
    // ----------------------------------------------

    const modeAliases = {
      sales: 'SALES',
      meeting: 'MEETING',
      school: 'SCHOOL',
      general: 'GENERAL',
    }

    for (
      const [
        spoken,
        targetMode,
      ] of
      Object.entries(
        modeAliases,
      )
    ) {
      if (
        normalized.includes(
          `change mode to ${spoken}`,
        ) ||
        normalized.includes(
          `switch to ${spoken}`,
        ) ||
        normalized.includes(
          `${spoken} mode`,
        )
      ) {
        console.log(
          'VOICE COMMAND: MODE',
          targetMode,
        )

        if (noteTaking) {
          await stopNotes()
        }

        mode = targetMode

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

    // ----------------------------------------------
    // START NOTES
    // ----------------------------------------------

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

    // ----------------------------------------------
    // STOP NOTES
    // ----------------------------------------------

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

    if (
      await maybeHandleCommand(
        question,
      )
    ) {
      return
    }

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 550,

        system: `
Answer a direct smart-glasses question.

${modePrompt()}

Use:
- session setup
- preloaded intelligence
- live conversation

Be concise and direct.

If numbers are involved, calculate carefully.

Maximum 70 words.
`,

        messages: [
          {
            role: 'user',

            content: `
SESSION CONTEXT:

${sessionContext.summary || 'None'}

COMPANY:
${sessionContext.company || 'None'}

COURSE:
${sessionContext.course || 'None'}

TOPIC:
${sessionContext.topic || 'None'}

PRELOADED INTELLIGENCE:

${sessionContextIntel || 'None'}

LIVE CONVERSATION:

${conversation.join('\n')}

QUESTION:

${question}
`,
          },
        ],
      })

    const answer =
      extractText(response)

    sendToG2({
      type:
        'manual_answer',

      text: answer,
    })
  }

  function finishManualAsk() {
    if (!manualAskActive) {
      return
    }

    if (manualAskTimer) {
      clearTimeout(
        manualAskTimer,
      )

      manualAskTimer = null
    }

    const question =
      manualAskBuffer
        .join(' ')
        .trim()

    manualAskActive = false
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
    if (manualAskTimer) {
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
  // RESTORE AFTER RECONNECT
  // ==================================================

  async function restoreSession(payload) {
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
      mode = requestedMode
    }

    if (payload.context) {
      sessionContext = {
        raw:
          String(
            payload.context.raw ||
              '',
          ),

        summary:
          String(
            payload.context.summary ||
              '',
          ),

        company:
          String(
            payload.context.company ||
              '',
          ),

        course:
          String(
            payload.context.course ||
              '',
          ),

        topic:
          String(
            payload.context.topic ||
              '',
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

    console.log(
      'SESSION RESTORED AFTER RECONNECT',
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

        if (!message.is_final) {
          return
        }

        // ------------------------------------------
        // CONTEXT CAPTURE
        // ------------------------------------------

        if (
          contextCaptureActive
        ) {
          contextCaptureBuffer.push(
            transcript,
          )

          console.log(
            'CONTEXT CAPTURE:',
            transcript,
          )

          scheduleContextFinish()

          return
        }

        // ------------------------------------------
        // MANUAL ASK
        // Do not put assistant commands into notes.
        // ------------------------------------------

        if (manualAskActive) {
          manualAskBuffer.push(
            transcript,
          )

          scheduleManualAskFinish()

          return
        }

        // ------------------------------------------
        // NOTES
        // ------------------------------------------

        if (noteTaking) {
          noteTranscript.push(
            transcript,
          )

          console.log(
            'NOTE CAPTURE:',
            transcript,
          )
        }

        // ------------------------------------------
        // NORMAL LIVE CONTEXT
        // ------------------------------------------

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
          payload.mode || '',
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
        mode = requested

        console.log(
          'MODE:',
          mode,
        )

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
      contextCaptureActive = true
      contextCaptureBuffer = []

      if (contextCaptureTimer) {
        clearTimeout(
          contextCaptureTimer,
        )

        contextCaptureTimer = null
      }

      console.log(
        'SESSION CONTEXT CAPTURE STARTED',
      )

      return
    }

    if (
      payload.type ===
      'context_skip'
    ) {
      contextCaptureActive = false
      contextCaptureBuffer = []

      if (contextCaptureTimer) {
        clearTimeout(
          contextCaptureTimer,
        )

        contextCaptureTimer = null
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
      manualAskActive = true
      manualAskBuffer = []

      return
    }

    if (
      payload.type ===
      'manual_ask_cancel'
    ) {
      manualAskActive = false
      manualAskBuffer = []

      if (manualAskTimer) {
        clearTimeout(
          manualAskTimer,
        )

        manualAskTimer = null
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

  // ==================================================
  // G2 SOCKET
  // ==================================================

  g2Socket.on(
    'message',
    data => {
      if (
        Buffer.isBuffer(data)
      ) {
        const text =
          data.toString('utf8')

        if (
          text.startsWith('{')
        ) {
          try {
            handleControlMessage(
              JSON.parse(text),
            )

            return
          } catch {
            // treat as audio
          }
        }
      }

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
        deepgramSocket.readyState ===
        WebSocket.OPEN
      ) {
        deepgramSocket.send(data)
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
        noteTranscript.length > 0
      ) {
        noteTaking = false

        generateNotes()
          .catch(
            console.error,
          )
      }

      if (manualAskTimer) {
        clearTimeout(
          manualAskTimer,
        )
      }

      if (contextCaptureTimer) {
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
})

// ==================================================
// RAILWAY
// ==================================================

const PORT =
  process.env.PORT || 3001

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `G2 JARVIS v10 running on port ${PORT}`,
    )
  },
)