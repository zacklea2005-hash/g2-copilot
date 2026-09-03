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

const __filename =
  fileURLToPath(import.meta.url)

const __dirname =
  path.dirname(__filename)

const VERSION = '13.1'

// ==================================================
// APP
// ==================================================

const app = express()
app.use(cors())

const server =
  http.createServer(app)

const anthropic =
  new Anthropic({
    apiKey:
      process.env.ANTHROPIC_API_KEY,
  })

const tvly =
  tavily({
    apiKey:
      process.env.TAVILY_API_KEY,
  })

const wss =
  new WebSocketServer({
    server,
    path: '/audio',
  })

// ==================================================
// GOOGLE
// ==================================================

const GOOGLE_REDIRECT_URI =
  'https://g2-copilot-production.up.railway.app/google/callback'

function createGoogleOAuthClient() {
  const client =
    new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI,
    )

  if (
    process.env
      .GOOGLE_REFRESH_TOKEN
  ) {
    client.setCredentials({
      refresh_token:
        process.env
          .GOOGLE_REFRESH_TOKEN,
    })
  }

  return client
}

function assertDriveConfigured() {
  if (
    !process.env
      .GOOGLE_CLIENT_ID ||
    !process.env
      .GOOGLE_CLIENT_SECRET ||
    !process.env
      .GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error(
      'GOOGLE_DRIVE_NOT_CONNECTED',
    )
  }
}

function createDriveClient() {
  assertDriveConfigured()

  return google.drive({
    version: 'v3',
    auth:
      createGoogleOAuthClient(),
  })
}

const driveFolderCache =
  new Map()

// ==================================================
// STORAGE
// ==================================================

const DATA_DIR =
  path.join(
    __dirname,
    'data',
  )

const MEMORY_FILE =
  path.join(
    DATA_DIR,
    'memory.json',
  )

const SESSION_DIR =
  path.join(
    DATA_DIR,
    'sessions',
  )

fs.mkdirSync(
  DATA_DIR,
  {
    recursive: true,
  },
)

fs.mkdirSync(
  SESSION_DIR,
  {
    recursive: true,
  },
)

function loadMemory() {
  try {
    if (
      !fs.existsSync(
        MEMORY_FILE,
      )
    ) {
      return {
        entities: {},
        accounts: {},
      }
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          MEMORY_FILE,
          'utf8',
        ),
      )

    return {
      entities:
        parsed.entities ||
        {},

      accounts:
        parsed.accounts ||
        {},
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

let persistentMemory =
  loadMemory()

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
// RECONNECT-SAFE SESSION STORE
// ==================================================

const activeSessions =
  new Map()

const SESSION_TTL_MS =
  6 * 60 * 60 * 1000

function validSessionId(
  value,
) {
  return (
    typeof value ===
      'string' &&
    /^[a-zA-Z0-9_-]{8,120}$/.test(
      value,
    )
  )
}

function checkpointPath(
  sessionId,
) {
  return path.join(
    SESSION_DIR,
    `${sessionId}.json`,
  )
}

function blankContext() {
  return {
    raw: '',
    summary: '',
    company: '',
    course: '',
    topic: '',
    modeHint: '',
  }
}

function createStoredSession(
  sessionId,
) {
  const now = Date.now()

  return {
    sessionId,

    mode: 'SALES',

    context:
      blankContext(),

    notesActive: false,
    noteTranscript: [],

    conversation: [],
    rollingSummary: '',

    createdAt: now,
    updatedAt: now,
    lastSeen: now,
  }
}

function saveSessionCheckpoint(
  session,
) {
  if (
    !session ||
    !validSessionId(
      session.sessionId,
    )
  ) {
    return
  }

  try {
    fs.writeFileSync(
      checkpointPath(
        session.sessionId,
      ),

      JSON.stringify(
        session,
        null,
        2,
      ),
    )
  } catch (error) {
    console.error(
      'SESSION CHECKPOINT ERROR:',
      error?.message ||
        error,
    )
  }
}

function loadSessionCheckpoint(
  sessionId,
) {
  try {
    const file =
      checkpointPath(
        sessionId,
      )

    if (
      !fs.existsSync(file)
    ) {
      return null
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          file,
          'utf8',
        ),
      )

    if (
      Date.now() -
        Number(
          parsed.lastSeen ||
            parsed.updatedAt ||
            0,
        ) >
      SESSION_TTL_MS
    ) {
      try {
        fs.unlinkSync(file)
      } catch {
        // ignore
      }

      return null
    }

    return {
      ...createStoredSession(
        sessionId,
      ),

      ...parsed,

      sessionId,

      context: {
        ...blankContext(),

        ...(
          parsed.context ||
          {}
        ),
      },

      noteTranscript:
        Array.isArray(
          parsed.noteTranscript,
        )
          ? parsed.noteTranscript
          : [],

      conversation:
        Array.isArray(
          parsed.conversation,
        )
          ? parsed.conversation
          : [],
    }
  } catch (error) {
    console.error(
      'SESSION CHECKPOINT LOAD ERROR:',
      error?.message ||
        error,
    )

    return null
  }
}

function obtainStoredSession(
  sessionId,
) {
  const inMemory =
    activeSessions.get(
      sessionId,
    )

  if (inMemory) {
    inMemory.lastSeen =
      Date.now()

    return {
      session: inMemory,
      resumed: true,
    }
  }

  const checkpoint =
    loadSessionCheckpoint(
      sessionId,
    )

  if (checkpoint) {
    checkpoint.lastSeen =
      Date.now()

    activeSessions.set(
      sessionId,
      checkpoint,
    )

    return {
      session:
        checkpoint,

      resumed: true,
    }
  }

  const fresh =
    createStoredSession(
      sessionId,
    )

  activeSessions.set(
    sessionId,
    fresh,
  )

  saveSessionCheckpoint(
    fresh,
  )

  return {
    session: fresh,
    resumed: false,
  }
}

setInterval(
  () => {
    const now =
      Date.now()

    for (
      const [
        sessionId,
        session,
      ]
      of activeSessions
    ) {
      if (
        now -
          session.lastSeen >
        SESSION_TTL_MS
      ) {
        activeSessions.delete(
          sessionId,
        )

        try {
          const file =
            checkpointPath(
              sessionId,
            )

          if (
            fs.existsSync(file)
          ) {
            fs.unlinkSync(file)
          }
        } catch {
          // ignore cleanup failure
        }
      }
    }
  },
  15 * 60 * 1000,
)

// ==================================================
// CACHE
// ==================================================

const researchCache =
  new Map()

const RESEARCH_CACHE_MS =
  20 * 60 * 1000

const ACCOUNT_CACHE_MS =
  6 * 60 * 60 * 1000

// ==================================================
// HELPERS
// ==================================================

function cleanJson(raw) {
  return String(raw || '')
    .replace(
      /^```json\s*/i,
      '',
    )
    .replace(
      /^```\s*/i,
      '',
    )
    .replace(
      /\s*```$/i,
      '',
    )
    .trim()
}

function extractText(
  response,
) {
  return response.content
    .filter(
      item =>
        item.type ===
        'text',
    )
    .map(
      item => item.text,
    )
    .join('\n')
    .trim()
}

function parseClaudeJson(
  raw,
) {
  const cleaned =
    cleanJson(raw)

  try {
    return JSON.parse(
      cleaned,
    )
  } catch {
    const start =
      cleaned.indexOf('{')

    const end =
      cleaned.lastIndexOf(
        '}',
      )

    if (
      start !== -1 &&
      end > start
    ) {
      try {
        return JSON.parse(
          cleaned.slice(
            start,
            end + 1,
          ),
        )
      } catch {
        return null
      }
    }

    return null
  }
}

function normalizedText(
  value,
) {
  return String(value || '')
    .toLowerCase()
    .replace(
      /[^\w\s$%.+-]/g,
      ' ',
    )
    .replace(
      /\s+/g,
      ' ',
    )
    .trim()
}

function clamp(
  value,
  min,
  max,
) {
  return Math.max(
    min,
    Math.min(
      max,
      value,
    ),
  )
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms,
      ),
  )
}

function escapeDriveQuery(
  value,
) {
  return String(value)
    .replace(
      /\\/g,
      '\\\\',
    )
    .replace(
      /'/g,
      "\\'",
    )
}

function safeFileName(
  value,
) {
  return String(
    value || 'Notes',
  )
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      '',
    )
    .replace(
      /\s+/g,
      ' ',
    )
    .trim()
    .slice(0, 100)
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
  const a =
    tokenSet(first)

  const b =
    tokenSet(second)

  if (
    a.size === 0 ||
    b.size === 0
  ) {
    return 0
  }

  let intersection = 0

  for (
    const token
    of a
  ) {
    if (b.has(token)) {
      intersection += 1
    }
  }

  const union =
    new Set([
      ...a,
      ...b,
    ]).size

  return (
    intersection /
    union
  )
}

async function withRetry(
  fn,
  {
    attempts = 3,
    delayMs = 900,
    label = 'operation',
  } = {},
) {
  let lastError

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      console.error(
        `${label} failed ${attempt}/${attempts}:`,
        error?.message ||
          error,
      )

      if (
        attempt < attempts
      ) {
        await sleep(
          delayMs *
            attempt,
        )
      }
    }
  }

  throw lastError
}

// ==================================================
// RESEARCH
// ==================================================

async function cachedSearch(
  query,
  {
    searchDepth =
      'basic',

    maxResults = 5,

    includeAnswer =
      true,

    ttl =
      RESEARCH_CACHE_MS,
  } = {},
) {
  const key =
    `${searchDepth}:${maxResults}:${normalizedText(
      query,
    )}`

  const cached =
    researchCache.get(
      key,
    )

  if (
    cached &&
    Date.now() -
      cached.createdAt <
      ttl
  ) {
    return cached.data
  }

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

  if (
    researchCache.size >
    150
  ) {
    const oldest =
      [
        ...researchCache
          .entries(),
      ]
        .sort(
          (a, b) =>
            a[1].createdAt -
            b[1].createdAt,
        )
        .slice(0, 50)

    for (
      const [oldKey]
      of oldest
    ) {
      researchCache.delete(
        oldKey,
      )
    }
  }

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
      ).slice(
        0,
        650,
      )

    return (
      `${item.title || ''}: ` +
      content
    )
  })
  .join('\n')}
`
}

// ==================================================
// HTTP
// ==================================================

app.get(
  '/',
  (req, res) => {
    res.send(
      `G2 Copilot JARVIS v${VERSION} running`,
    )
  },
)

app.get(
  '/health',
  (req, res) => {
    res.json({
      status: 'ok',

      version:
        VERSION,

      reconnectSafeNotes:
        true,

      confirmedNoteState:
        true,

      sessionCheckpoints:
        true,

      sessionTTLHours:
        6,

      silentSchoolSelection:
        true,

      automaticTopicDetection:
        true,

      longConversationMemory:
        true,

      longNoteChunking:
        true,

      dynamicCardRanking:
        true,

      modeIntelligence:
        true,

      accountIntelligence:
        true,

      entityEnrichment:
        true,

      claimVerification:
        true,

      numericalIntelligence:
        true,

      deepgramReconnect:
        true,

      notes:
        true,

      drive:
        Boolean(
          process.env
            .GOOGLE_REFRESH_TOKEN,
        ),
    })
  },
)

// ==================================================
// GOOGLE OAUTH
// ==================================================

app.get(
  '/google/auth',
  (req, res) => {
    const client =
      createGoogleOAuthClient()

    const url =
      client.generateAuthUrl({
        access_type:
          'offline',

        prompt:
          'consent',

        scope: [
          'https://www.googleapis.com/auth/drive.file',

          'https://www.googleapis.com/auth/drive.metadata.readonly',
        ],
      })

    res.redirect(url)
  },
)

app.get(
  '/google/callback',
  async (
    req,
    res,
  ) => {
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
            'Missing authorization code.',
          )
      }

      const client =
        createGoogleOAuthClient()

      const {
        tokens,
      } =
        await client.getToken(
          code,
        )

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

  const escaped =
    escapeDriveQuery(
      name,
    )

  const query = [
    `name = '${escaped}'`,

    `mimeType = 'application/vnd.google-apps.folder'`,

    'trashed = false',

    parentId
      ? `'${parentId}' in parents`
      : `'root' in parents`,
  ].join(
    ' and ',
  )

  const result =
    await withRetry(
      () =>
        drive.files.list({
          q: query,

          fields:
            'files(id,name)',

          pageSize: 20,
        }),

      {
        label:
          `Drive folder ${name}`,
      },
    )

  const folder =
    result.data
      .files?.[0]

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
    folder:
      course,

    path:
      `G2 Copilot / School / ${route.course}`,
  }
}

function wrapNoteHtml(
  title,
  body,
) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>
`
}

async function createGoogleDoc(
  title,
  html,
  folderId,
) {
  const drive =
    createDriveClient()

  const result =
    await withRetry(
      () =>
        drive.files.create({
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

            body:
              wrapNoteHtml(
                title,
                html,
              ),
          },

          fields:
            'id,name,webViewLink',
        }),

      {
        attempts: 3,

        delayMs: 1200,

        label:
          'Google Doc save',
      },
    )

  return result.data
}

// ==================================================
// SCHOOL
// ==================================================

const ALLOWED_COURSES = [
  'STAT 340',
  'MATH 340',
  'LIS 462',
  'COMP SCI 320',
]

async function classifySchoolCourse(
  transcript,
) {
  const response =
    await anthropic.messages.create({
      model:
        'claude-sonnet-5',

      max_tokens: 180,

      system: `
Classify the lecture into exactly one:

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
`,

      messages: [
        {
          role: 'user',
          content:
            transcript,
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
    ALLOWED_COURSES.includes(
      parsed?.course,
    ) &&
    Number(
      parsed?.confidence ||
        0,
    ) >= 6
  ) {
    return parsed.course
  }

  return null
}

// ==================================================
// CONNECTION
// ==================================================

wss.on(
  'connection',
  g2Socket => {
    console.log(
      '\n==============================',
    )

    console.log(
      'NEW G2 JARVIS v13.1 SOCKET',
    )

    console.log(
      '==============================\n',
    )

    // ----------------------------------------------
    // CONNECTION-LOCAL STATE
    // ----------------------------------------------

    let clientSessionId =
      null

    let storedSession =
      null

    let mode =
      'SALES'

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

    let manualAskActive =
      false

    let manualAskBuffer = []
    let manualAskTimer = null

    let noteTaking = false
    let noteTranscript = []

    let contextCaptureActive =
      false

    let contextCaptureBuffer =
      []

    let contextCaptureTimer =
      null

    let topicInferenceRunning =
      false

    let topicInferenceAttempts =
      0

    let sessionContext =
      blankContext()

    let sessionContextIntel = ''
    let sessionModeIntel = {}

    let closingConnection =
      false

    const MIN_RELEVANCE =
      7

    // ==============================================
    // SEND
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
        JSON.stringify(
          payload,
        ),
      )

      return true
    }

    // ==============================================
    // STORED SESSION SYNC
    // ==============================================

    function persistSessionState(
      checkpoint = false,
    ) {
      if (!storedSession) {
        return
      }

      storedSession.mode =
        mode

      storedSession.context = {
        ...sessionContext,
      }

      storedSession.notesActive =
        noteTaking

      storedSession.noteTranscript =
        [
          ...noteTranscript,
        ]

      storedSession.conversation =
        conversation.slice(
          -80,
        )

      storedSession.rollingSummary =
        rollingSummary

      storedSession.updatedAt =
        Date.now()

      storedSession.lastSeen =
        Date.now()

      if (checkpoint) {
        saveSessionCheckpoint(
          storedSession,
        )
      }
    }

    async function attachSession(
      payload,
    ) {
      const requestedId =
        String(
          payload.sessionId ||
            '',
        )

      if (
        !validSessionId(
          requestedId,
        )
      ) {
        sendToG2({
          type:
            'session_attach_error',

          text:
            'Invalid session ID.',
        })

        return
      }

      clientSessionId =
        requestedId

      const result =
        obtainStoredSession(
          clientSessionId,
        )

      storedSession =
        result.session

      mode =
        storedSession.mode ||
        'SALES'

      sessionContext = {
        ...blankContext(),

        ...(
          storedSession.context ||
          {}
        ),
      }

      noteTaking =
        storedSession
          .notesActive === true

      noteTranscript =
        Array.isArray(
          storedSession
            .noteTranscript,
        )
          ? [
              ...storedSession
                .noteTranscript,
            ]
          : []

      conversation =
        Array.isArray(
          storedSession
            .conversation,
        )
          ? [
              ...storedSession
                .conversation,
            ]
          : []

      rollingSummary =
        String(
          storedSession
            .rollingSummary ||
            '',
        )

      transcriptRevision =
        conversation.length

      analyzedRevision =
        transcriptRevision

      if (
        sessionContext.company
      ) {
        await preloadSessionIntel()
      }

      persistSessionState(
        true,
      )

      console.log(
        result.resumed
          ? 'SESSION REATTACHED:'
          : 'SESSION CREATED:',

        clientSessionId,
      )

      console.log(
        'SESSION MODE:',
        mode,
      )

      console.log(
        'SESSION COURSE:',
        sessionContext.course ||
          'none',
      )

      console.log(
        'NOTES ACTIVE:',
        noteTaking,
      )

      console.log(
        'NOTES RESTORED:',
        noteTranscript.length,
        'segments',
      )

      sendToG2({
        type:
          'session_attached',

        sessionId:
          clientSessionId,

        resumed:
          result.resumed,

        mode,

        context:
          sessionContext,

        notesActive:
          noteTaking,

        noteSegments:
          noteTranscript.length,
      })
    }

    // ==============================================
    // MODE PROMPT
    // ==============================================

    function modePrompt() {
      if (
        mode === 'GENERAL'
      ) {
        return `
GENERAL MODE.

Act like a proactive everyday JARVIS.

Prioritize useful facts, people, companies,
technology, definitions, calculations,
corrections and useful connections.

Avoid trivial interruptions.
`
      }

      if (
        mode === 'MEETING'
      ) {
        return `
MEETING MODE.

Act like a live chief of staff.

Prioritize decisions, commitments, owners,
deadlines, blockers, risks,
open questions and action items.
`
      }

      if (
        mode === 'SCHOOL'
      ) {
        return `
SCHOOL MODE.

Act like an elite live tutor.

Prioritize concepts, definitions, formulas,
variables, intuition, examples,
connections, misconceptions,
professor emphasis and likely testable material.

Do not simply repeat the professor.
Add understanding.
`
      }

      return `
SALES MODE.

Act like an elite technology sales copilot.

Prioritize customer pain, initiatives,
technical environment, cloud,
cybersecurity, AI, data,
infrastructure, licensing,
vendors, competitors,
renewals, budget, timeline,
stakeholders, objections,
buying signals and next-best actions.
`
    }

    function recentConversation(
      count = 18,
    ) {
      return conversation
        .slice(-count)
        .join('\n')
    }

    function fullWorkingContext() {
      return `
SESSION MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(22) || 'None'}
`
    }

    // ==============================================
    // RESET
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

      contextCaptureActive =
        false

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

      topicInferenceRunning =
        false

      topicInferenceAttempts =
        0

      sessionContext =
        blankContext()

      sessionContextIntel = ''
      sessionModeIntel = {}

      persistSessionState(
        true,
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

    const deepgramParams =
      new URLSearchParams({
        model: 'nova-3',

        encoding:
          'linear16',

        sample_rate:
          '16000',

        channels:
          '1',

        interim_results:
          'true',

        smart_format:
          'true',

        endpointing:
          '300',
      })

    let deepgramSocket =
      null

    let deepgramReconnectTimer =
      null

    let deepgramReconnectAttempts =
      0

    let deepgramKeepAliveTimer =
      null

    function clearDeepgramTimers() {
      if (
        deepgramReconnectTimer
      ) {
        clearTimeout(
          deepgramReconnectTimer,
        )

        deepgramReconnectTimer =
          null
      }

      if (
        deepgramKeepAliveTimer
      ) {
        clearInterval(
          deepgramKeepAliveTimer,
        )

        deepgramKeepAliveTimer =
          null
      }
    }

    function scheduleDeepgramReconnect() {
      if (
        closingConnection ||
        g2Socket.readyState !==
          WebSocket.OPEN ||
        deepgramReconnectTimer
      ) {
        return
      }

      deepgramReconnectAttempts +=
        1

      const delay =
        Math.min(
          deepgramReconnectAttempts *
            1000,

          8000,
        )

      console.log(
        'Deepgram reconnect in',
        delay,
        'ms',
      )

      deepgramReconnectTimer =
        setTimeout(
          () => {
            deepgramReconnectTimer =
              null

            connectDeepgram()
          },
          delay,
        )
    }

    function connectDeepgram() {
      if (
        closingConnection
      ) {
        return
      }

      if (
        deepgramSocket &&
        (
          deepgramSocket
            .readyState ===
            WebSocket.OPEN ||

          deepgramSocket
            .readyState ===
            WebSocket.CONNECTING
        )
      ) {
        return
      }

      deepgramSocket =
        new WebSocket(
          `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`,

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

          deepgramReconnectAttempts =
            0

          if (
            deepgramKeepAliveTimer
          ) {
            clearInterval(
              deepgramKeepAliveTimer,
            )
          }

          deepgramKeepAliveTimer =
            setInterval(
              () => {
                if (
                  deepgramSocket
                    ?.readyState ===
                  WebSocket.OPEN
                ) {
                  try {
                    deepgramSocket.send(
                      JSON.stringify({
                        type:
                          'KeepAlive',
                      }),
                    )
                  } catch {
                    // reconnect handler
                  }
                }
              },
              8000,
            )
        },
      )

      deepgramSocket.on(
        'message',
        handleDeepgramMessage,
      )

      deepgramSocket.on(
        'close',
        () => {
          console.log(
            'Deepgram disconnected',
          )

          if (
            deepgramKeepAliveTimer
          ) {
            clearInterval(
              deepgramKeepAliveTimer,
            )

            deepgramKeepAliveTimer =
              null
          }

          scheduleDeepgramReconnect()
        },
      )

      deepgramSocket.on(
        'error',
        error => {
          console.error(
            'Deepgram error:',
            error?.message ||
              error,
          )
        },
      )
    }

    function sendAudioToDeepgram(
      data,
    ) {
      if (
        deepgramSocket
          ?.readyState ===
        WebSocket.OPEN
      ) {
        deepgramSocket.send(
          data,
        )
      }
    }

    function stopDeepgram() {
      clearDeepgramTimers()

      if (
        deepgramSocket &&
        (
          deepgramSocket
            .readyState ===
            WebSocket.OPEN ||

          deepgramSocket
            .readyState ===
            WebSocket.CONNECTING
        )
      ) {
        try {
          deepgramSocket.close()
        } catch {
          // ignore
        }
      }

      deepgramSocket = null
    }

    connectDeepgram()

    // ==============================================
    // LONG CONVERSATION MEMORY
    // ==============================================

    async function compressConversationIfNeeded() {
      if (
        summarizingConversation ||
        conversation.length <
          34
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

            max_tokens: 700,

            system: `
Compress old live conversation into useful memory.

${modePrompt()}

Preserve:
people, companies, numbers,
goals, pain points, claims,
decisions, objections,
commitments, technical details,
formulas, concepts,
action items and unresolved questions.

Do not invent information.

Maximum 240 words.
`,

            messages: [
              {
                role:
                  'user',

                content: `
EXISTING MEMORY:

${rollingSummary || 'None'}

OLDER CONVERSATION:

${oldItems.join('\n')}
`,
              },
            ],
          })

        rollingSummary =
          extractText(
            response,
          )

        conversation.splice(
          0,
          oldItems.length,
        )

        persistSessionState()
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

    async function getAccountIntel(
      company,
    ) {
      if (!company) {
        return ''
      }

      const key =
        normalizedText(
          company,
        )

      const existing =
        persistentMemory
          .accounts[key]

      if (
        existing &&
        Date.now() -
          Number(
            existing.updatedAt ||
              0,
          ) <
          ACCOUNT_CACHE_MS
      ) {
        return (
          existing.text ||
          ''
        )
      }

      try {
        const result =
          await cachedSearch(
            `${company} latest strategy priorities AI cloud cybersecurity data technology partnerships acquisitions earnings 2026`,

            {
              searchDepth:
                'advanced',

              maxResults:
                6,

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
Create concise account intelligence
for a technology seller.

Only use supplied research.

Capture company direction,
strategic priorities,
AI/cloud/security/data signals,
business pressure,
technology signals,
and useful opportunity hypotheses.

Do not fabricate.

Maximum 250 words.
`,

            messages: [
              {
                role:
                  'user',

                content:
                  compactResearch(
                    result,
                  ),
              },
            ],
          })

        const text =
          extractText(
            response,
          )

        persistentMemory
          .accounts[key] = {
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
    // BRIEFING
    // ==============================================

    async function generateContextBriefing() {
      if (
        mode === 'SCHOOL' &&
        sessionContext.course &&
        !sessionContext.topic
      ) {
        return []
      }

      if (
        !sessionContext.summary &&
        !sessionContext.company &&
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
Create a short pre-conversation smart-glasses briefing.

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

Return ONLY valid JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "body": ""
    }
  ]
}

Do not fabricate.
`,

            messages: [
              {
                role:
                  'user',

                content: `
MODE:
${mode}

SESSION:
${JSON.stringify(
  sessionContext,
)}

INTELLIGENCE:
${sessionContextIntel || 'None'}
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

        return Array.isArray(
          parsed?.cards,
        )
          ? parsed.cards
          : []
      } catch (error) {
        console.error(
          'Briefing error:',
          error,
        )

        return []
      }
    }

    // ==============================================
    // SILENT CONTEXT
    // ==============================================

    async function applyDirectContext(
      incoming,
    ) {
      let course =
        String(
          incoming?.course ||
            '',
        ).trim()

      if (
        course &&
        !ALLOWED_COURSES.includes(
          course,
        )
      ) {
        course = ''
      }

      sessionContext = {
        raw: '',

        summary:
          String(
            incoming?.summary ||
              (
                course
                  ? `${course} class`
                  : ''
              ),
          ).trim(),

        company:
          String(
            incoming?.company ||
              '',
          ).trim(),

        course,

        topic:
          String(
            incoming?.topic ||
              '',
          ).trim(),

        modeHint:
          mode,
      }

      topicInferenceAttempts =
        0

      await preloadSessionIntel()

      persistSessionState(
        true,
      )

      const briefing =
        await generateContextBriefing()

      sendToG2({
        type:
          'context_ready',

        context: {
          ...sessionContext,
        },

        briefing,
      })
    }

    // ==============================================
    // SPOKEN CONTEXT
    // ==============================================

    async function processSessionContext(
      rawContext,
    ) {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 450,

          system: `
Extract smart-glasses session context.

Current mode:
${mode}

Known courses:
STAT 340
MATH 340
LIS 462
COMP SCI 320

Return ONLY valid JSON:

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
              role:
                'user',

              content:
                rawContext,
            },
          ],
        })

      const parsed =
        parseClaudeJson(
          extractText(
            response,
          ),
        )

      sessionContext = {
        raw:
          rawContext,

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

      topicInferenceAttempts =
        0

      await preloadSessionIntel()

      persistSessionState(
        true,
      )

      const briefing =
        await generateContextBriefing()

      sendToG2({
        type:
          'context_ready',

        context: {
          ...sessionContext,
        },

        briefing,
      })
    }

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

      contextCaptureBuffer =
        []

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
          'Context error:',
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
    // SCHOOL TOPIC
    // ==============================================

    async function maybeInferSchoolTopic() {
      if (
        mode !== 'SCHOOL' ||
        !sessionContext.course ||
        sessionContext.topic ||
        topicInferenceRunning ||
        topicInferenceAttempts >=
          3
      ) {
        return
      }

      const sample =
        recentConversation(
          14,
        )

      if (
        conversation.length <
          6 ||
        sample.length < 300
      ) {
        return
      }

      topicInferenceRunning =
        true

      topicInferenceAttempts +=
        1

      try {
        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens:
              250,

            system: `
Infer the specific lecture topic.

Selected class:

${sessionContext.course}

Do not guess if unclear.

Return ONLY JSON:

{
  "topic": "linear regression",
  "confidence": 9
}

Keep the topic to 2-6 words.
`,

            messages: [
              {
                role:
                  'user',

                content:
                  sample,
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
          parsed?.topic &&
          Number(
            parsed?.confidence ||
              0,
          ) >= 7
        ) {
          sessionContext.topic =
            String(
              parsed.topic,
            ).trim()

          sessionContext.summary =
            `${sessionContext.course} lecture about ${sessionContext.topic}`

          persistSessionState(
            true,
          )

          console.log(
            'SCHOOL TOPIC DETECTED:',
            sessionContext.topic,
          )

          sendToG2({
            type:
              'context_updated',

            context: {
              ...sessionContext,
            },
          })
        }
      } catch (error) {
        console.error(
          'Topic inference error:',
          error,
        )
      } finally {
        topicInferenceRunning =
          false
      }
    }

    // ==============================================
    // TRIGGER ENGINE
    // ==============================================

    async function analyzeMoment() {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens: 900,

          system: `
You are the interruption engine
for proactive smart glasses.

${modePrompt()}

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

Avoid greetings, filler,
repetition, obvious information,
and weak trivia.

Return ONLY JSON:

{
  "interrupt": true,
  "relevance": 9,
  "urgency": 8,
  "why_now": "",
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
              role:
                'user',

              content: `
SESSION:
${JSON.stringify(
  sessionContext,
)}

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
          extractText(
            response,
          ),
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
            parsed.why_now ||
              '',
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
    // NUMBERS
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
Analyze useful numerical implications.

In School mode,
calculate mathematical/statistical
implications when supported.

Do not invent missing values.

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
                role:
                  'user',

                content:
                  fullWorkingContext(),
              },
            ],
          })

        return (
          parseClaudeJson(
            extractText(
              response,
            ),
          ) || {
            useful: false,
          }
        )
      } catch (error) {
        console.error(
          'Number analysis error:',
          error,
        )

        return {
          useful: false,
        }
      }
    }

    // ==============================================
    // CLAIM CHECKING
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
          .map(
            signal =>
              String(
                signal.text ||
                  '',
              ).trim(),
          )
          .filter(Boolean)
          .slice(0, 3)

      const unseen =
        claims.filter(
          claim =>
            !recentClaims.includes(
              normalizedText(
                claim,
              ),
            ),
        )

      if (
        unseen.length === 0
      ) {
        return {
          checked: false,
          claims: [],
        }
      }

      try {
        const research =
          await cachedSearch(
            unseen.join(
              ' OR ',
            ),

            {
              searchDepth:
                'advanced',

              maxResults:
                6,
            },
          )

        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens:
              950,

            system: `
Verify factual claims using research.

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
                role:
                  'user',

                content: `
CLAIMS:
${JSON.stringify(
  unseen,
)}

RESEARCH:
${compactResearch(
  research,
)}
`,
              },
            ],
          })

        recentClaims.push(
          ...unseen.map(
            normalizedText,
          ),
        )

        recentClaims =
          recentClaims.slice(
            -40,
          )

        return (
          parseClaudeJson(
            extractText(
              response,
            ),
          ) || {
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
    // ENTITY INTELLIGENCE
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

      const allowedTypes = [
        'PERSON',
        'COMPANY',
        'PRODUCT',
        'TECHNOLOGY',
        'ACRONYM',
      ]

      const candidates =
        trigger.signals
          .filter(
            signal =>
              allowedTypes.includes(
                signal.type,
              ),
          )
          .map(
            signal => ({
              type:
                String(
                  signal.type,
                ),

              name:
                String(
                  signal.text ||
                    '',
                ).trim(),
            }),
          )
          .filter(
            item =>
              item.name,
          )
          .slice(0, 4)

      const unseen =
        candidates.filter(
          item => {
            const key =
              `${item.type}:${normalizedText(
                item.name,
              )}`

            return (
              !recentEntities.includes(
                key,
              )
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
        const routing =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens:
              500,

            system: `
Choose entities worth enriching now.

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
                role:
                  'user',

                content: `
SESSION:
${sessionContext.summary || 'None'}

CONVERSATION:
${recentConversation(12)}

ENTITIES:
${JSON.stringify(
  unseen,
)}
`,
              },
            ],
          })

        const routed =
          parseClaudeJson(
            extractText(
              routing,
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

        const enriched =
          []

        for (
          const entity
          of selected
        ) {
          const key =
            `${entity.type}:${normalizedText(
              entity.name,
            )}`

          let researchText =
            ''

          const stored =
            persistentMemory
              .entities[key]

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

                    maxResults:
                      5,
                  },
                )

              researchText =
                compactResearch(
                  result,
                )
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

              max_tokens:
                450,

              system: `
Create one useful entity insight.

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
                  role:
                    'user',

                  content: `
ENTITY:
${JSON.stringify(
  entity,
)}

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

            persistentMemory
              .entities[key] = {
              ...parsed,

              researchText,

              updatedAt:
                Date.now(),
            }

            recentEntities.push(
              key,
            )
          }
        }

        recentEntities =
          recentEntities.slice(
            -50,
          )

        saveMemory()

        return {
          useful:
            enriched.length >
            0,

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
            trigger
              .research_query,

            {
              searchDepth:
                'basic',

              maxResults:
                5,
            },
          )

        return compactResearch(
          result,
        )
      } catch {
        return 'Research failed.'
      }
    }

    // ==============================================
    // MODE INTELLIGENCE
    // ==============================================

    async function analyzeModeIntelligence(
      trigger,
    ) {
      let schema

      if (
        mode === 'SALES'
      ) {
        schema = `
{
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
  "important_context": "",
  "useful_connection": "",
  "uncertainty": "",
  "next_question": ""
}
`
      }

      try {
        const response =
          await anthropic.messages.create({
            model:
              'claude-sonnet-5',

            max_tokens:
              1000,

            system: `
Analyze this live moment
for the selected mode.

${modePrompt()}

Do not create HUD cards yet.

Use only supported information.

Return ONLY JSON matching:

${schema}
`,

            messages: [
              {
                role:
                  'user',

                content: `
SESSION:
${JSON.stringify(
  sessionContext,
)}

CONTEXT INTEL:
${sessionContextIntel || 'None'}

ROLLING MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(16)}

TRIGGER:
${JSON.stringify(
  trigger,
)}
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

        if (parsed) {
          sessionModeIntel =
            parsed
        }

        return parsed || {}
      } catch (error) {
        console.error(
          'Mode intelligence error:',
          error,
        )

        return {}
      }
    }

    // ==============================================
    // CARDS
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
            card.relevance ||
              0,
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
                .map(
                  q =>
                    String(q)
                      .trim(),
                )
                .filter(Boolean)
                .slice(0, 3)
            : []

        if (
          questions.length <
          2
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
            card.body ||
              '',
          ).trim()

        if (!body) {
          return null
        }

        return {
          type:
            card.type,

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

    function cardText(
      card,
    ) {
      if (
        card.type ===
        'QUESTIONS'
      ) {
        return (
          card.questions ||
          []
        ).join(' ')
      }

      return (
        card.body ||
        ''
      )
    }

    function duplicatePenalty(
      card,
    ) {
      let highest = 0

      for (
        const existing
        of recentCards.slice(
          -14,
        )
      ) {
        highest =
          Math.max(
            highest,

            similarity(
              cardText(
                card,
              ),

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
      const scored =
        []

      for (
        const raw
        of candidates
      ) {
        const card =
          normalizeCard(raw)

        if (!card) {
          continue
        }

        const duplicate =
          duplicatePenalty(
            card,
          )

        if (
          duplicate >=
          0.68
        ) {
          continue
        }

        const score =
          card.relevance *
            0.55 +
          card.urgency *
            0.20 +
          card.novelty *
            0.25 -
          duplicate * 4

        scored.push({
          card,
          score,
        })
      }

      scored.sort(
        (a, b) =>
          b.score -
          a.score,
      )

      const selected =
        []

      const seenTypes =
        new Set()

      for (
        const item
        of scored
      ) {
        if (
          selected.length >=
          3
        ) {
          break
        }

        if (
          !seenTypes.has(
            item.card.type,
          ) ||
          selected.length ===
            0
        ) {
          selected.push(
            item.card,
          )

          seenTypes.add(
            item.card.type,
          )
        }
      }

      return selected
    }

    async function generateCandidateCards(
      trigger,
      numericalIntel,
      verification,
      entityIntel,
      research,
      modeIntel,
    ) {
      const recentText =
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

          max_tokens:
            1400,

          system: `
Generate candidate HUD cards.

${modePrompt()}

The experience should feel
like JARVIS, not a chatbot.

Useful cards:
- reveal implications
- calculate
- give timely context
- correct important claims
- identify risks
- identify buying signals
- explain difficult concepts
- connect ideas
- surface decisions/actions
- suggest excellent questions

Allowed:

KNOW_THIS
QUESTIONS
SAY_THIS

Generate up to 5 candidates.

KNOW_THIS:
max 26 words.

SAY_THIS:
max 22 words.

QUESTIONS:
2-3 questions,
max 13 words each.

Every card has:

relevance: 1-10
urgency: 1-10
novelty: 1-10

Return ONLY JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "urgency": 8,
      "novelty": 9,
      "body": ""
    }
  ]
}

Do not fabricate.
Do not repeat recent cards.
`,

          messages: [
            {
              role:
                'user',

              content: `
SESSION:
${JSON.stringify(
  sessionContext,
)}

PRELOADED INTELLIGENCE:
${sessionContextIntel || 'None'}

ROLLING MEMORY:
${rollingSummary || 'None'}

RECENT CONVERSATION:
${recentConversation(16)}

TRIGGER:
${JSON.stringify(
  trigger,
)}

MODE INTELLIGENCE:
${JSON.stringify(
  modeIntel,
)}

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

LIVE RESEARCH:
${research}

RECENT CARDS:
${recentText || 'None'}
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

      return Array.isArray(
        parsed?.cards,
      )
        ? parsed.cards
        : []
    }

    function cooldownForTrigger(
      trigger,
    ) {
      if (
        trigger.urgency >=
          9 ||
        trigger.relevance >=
          10
      ) {
        return 3500
      }

      if (
        trigger.relevance >=
        9
      ) {
        return 5500
      }

      if (
        trigger.relevance >=
        8
      ) {
        return 7500
      }

      return 10000
    }

    function sendCards(
      cards,
    ) {
      for (
        const card
        of cards
      ) {
        sendToG2({
          type:
            'card',

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
          cardText(
            card,
          ),
        )
      }

      recentCards =
        recentCards.slice(
          -30,
        )

      if (
        cards.length >
        0
      ) {
        lastBundleAt =
          Date.now()
      }
    }

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
          const revision =
            transcriptRevision

          try {
            const trigger =
              await analyzeMoment()

            if (
              !trigger ||
              !trigger.interrupt ||
              trigger.relevance <
                MIN_RELEVANCE
            ) {
              analyzedRevision =
                revision

              continue
            }

            const cooldown =
              cooldownForTrigger(
                trigger,
              )

            const elapsed =
              Date.now() -
              lastBundleAt

            const breakCooldown =
              trigger.urgency >=
                9 ||
              trigger.relevance >=
                10

            if (
              elapsed <
                cooldown &&
              !breakCooldown
            ) {
              analyzedRevision =
                revision

              continue
            }

            const [
              numbers,
              verification,
              entities,
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
                numbers,
                verification,
                entities,
                research,
                modeIntel,
              )

            sendCards(
              rankCards(
                candidates,
              ),
            )
          } catch (error) {
            console.error(
              'JARVIS ANALYSIS ERROR:',
              error,
            )
          }

          analyzedRevision =
            revision
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
    // NOTES
    // ==============================================

    async function determineNoteRoute(
      transcript,
    ) {
      if (
        mode === 'SCHOOL'
      ) {
        if (
          ALLOWED_COURSES.includes(
            sessionContext.course,
          )
        ) {
          return {
            area:
              'SCHOOL',

            course:
              sessionContext.course,
          }
        }

        const course =
          await classifySchoolCourse(
            transcript,
          )

        return {
          area:
            'SCHOOL',

          course,
        }
      }

      if (
        mode === 'SALES' ||
        mode === 'MEETING'
      ) {
        return {
          area:
            'WORK',

          course: null,
        }
      }

      return {
        area:
          'GENERAL',

        course: null,
      }
    }

    function splitTranscript(
      transcript,
      maxChars = 14000,
    ) {
      const lines =
        String(
          transcript,
        )
          .split('\n')
          .filter(Boolean)

      const chunks =
        []

      let current =
        ''

      for (
        const line
        of lines
      ) {
        if (
          current.length +
            line.length +
            1 >
          maxChars
        ) {
          if (
            current.trim()
          ) {
            chunks.push(
              current.trim(),
            )
          }

          current =
            line
        } else {
          current +=
            (
              current
                ? '\n'
                : ''
            ) +
            line
        }
      }

      if (
        current.trim()
      ) {
        chunks.push(
          current.trim(),
        )
      }

      return chunks
    }

    async function condenseNoteChunk(
      chunk,
      index,
      total,
    ) {
      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            1800,

          system: `
Condense transcript chunk ${index}/${total}
for final note creation.

Preserve all important:
concepts,
definitions,
formulas,
numbers,
examples,
decisions,
action items,
names,
deadlines,
pain points,
technical details,
professor emphasis,
questions,
and corrections.

Remove filler and repetition.

Do not invent information.
`,

          messages: [
            {
              role:
                'user',

              content:
                chunk,
            },
          ],
        })

      return extractText(
        response,
      )
    }

    async function prepareNoteSource(
      transcript,
    ) {
      if (
        transcript.length <=
        20000
      ) {
        return transcript
      }

      const chunks =
        splitTranscript(
          transcript,
        )

      const results =
        []

      for (
        let i = 0;
        i < chunks.length;
        i += 1
      ) {
        const condensed =
          await withRetry(
            () =>
              condenseNoteChunk(
                chunks[i],
                i + 1,
                chunks.length,
              ),

            {
              attempts:
                2,

              label:
                `Note chunk ${i + 1}`,
            },
          )

        results.push(
          `SECTION ${i + 1}\n${condensed}`,
        )
      }

      return results.join(
        '\n\n',
      )
    }

    function notePrompt() {
      return `
You are an expert AI live note taker.

MODE:
${mode}

SESSION:
${sessionContext.summary || 'None'}

COURSE:
${sessionContext.course || 'None'}

AUTO-DETECTED TOPIC:
${sessionContext.topic || 'None'}

COMPANY:
${sessionContext.company || 'None'}

Create polished HTML notes.

Never invent facts.
Remove filler and repetition.

SCHOOL:

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

MEETING:

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

SALES:

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

Organize clearly by topic.

EVERY NOTE MUST END WITH:

<h2>AI SUMMARY &amp; EXPLANATION</h2>

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
  "title": "",
  "summary": "",
  "html": ""
}
`
    }

    async function generateStructuredNote(
      source,
    ) {
      for (
        let attempt = 1;
        attempt <= 2;
        attempt += 1
      ) {
        try {
          const response =
            await anthropic.messages.create({
              model:
                'claude-sonnet-5',

              max_tokens:
                6500,

              system:
                notePrompt(),

              messages: [
                {
                  role:
                    'user',

                  content: `
SOURCE MATERIAL:

${source}
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
            parsed?.title &&
            parsed?.html
          ) {
            return parsed
          }
        } catch (error) {
          console.error(
            `Note attempt ${attempt}:`,
            error,
          )
        }

        if (
          attempt < 2
        ) {
          await sleep(
            1000,
          )
        }
      }

      throw new Error(
        'NOTE_GENERATION_FAILED',
      )
    }

    async function generateNotes() {
      if (
        noteTranscript.length ===
        0
      ) {
        console.log(
          'NOTE SAVE ABORTED: 0 segments',
        )

        sendToG2({
          type:
            'notes_error',

          text:
            'No speech was captured.',
        })

        return false
      }

      const transcript =
        noteTranscript.join(
          '\n',
        )

      console.log(
        'GENERATING NOTES:',
        transcript.length,
        'chars',
      )

      console.log(
        'NOTE SEGMENTS:',
        noteTranscript.length,
      )

      try {
        const route =
          await determineNoteRoute(
            transcript,
          )

        const source =
          await prepareNoteSource(
            transcript,
          )

        const note =
          await generateStructuredNote(
            source,
          )

        const destination =
          await getDriveDestination(
            route,
          )

        console.log(
          'DESTINATION:',
          destination.path,
        )

        const date =
          new Date()
            .toISOString()
            .slice(0, 10)

        const cleanedTitle =
          safeFileName(
            note.title,
          )

        const title =
          `${date} — ${cleanedTitle}`

        const doc =
          await createGoogleDoc(
            title,
            note.html,
            destination.folder,
          )

        console.log(
          'GOOGLE DOC SAVED:',
          title,
        )

        sendToG2({
          type:
            'notes_saved',

          title:
            cleanedTitle,

          folder:
            destination.path,

          summary:
            note.summary ||
            '',

          url:
            doc?.webViewLink ||
            '',
        })

        return true
      } catch (error) {
        console.error(
          'NOTE SAVE ERROR:',
          error,
        )

        let message =
          'Could not save notes.'

        if (
          String(
            error?.message ||
              '',
          ).includes(
            'GOOGLE_DRIVE_NOT_CONNECTED',
          )
        ) {
          message =
            'Google Drive is not connected.'
        } else if (
          String(
            error?.message ||
              '',
          ).includes(
            'Drive folder not found',
          )
        ) {
          message =
            'Drive folder was not found.'
        } else if (
          String(
            error?.message ||
              '',
          ).includes(
            'NOTE_GENERATION_FAILED',
          )
        ) {
          message =
            'AI note generation failed.'
        }

        sendToG2({
          type:
            'notes_error',

          text:
            message,
        })

        return false
      }
    }

    function startNotes() {
      console.log(
        'NOTES START REQUEST',
      )

      console.log(
        'NOTES SESSION:',
        clientSessionId ||
          'not-attached',
      )

      if (!storedSession) {
        sendToG2({
          type:
            'notes_error',

          text:
            'Session is still connecting.',
        })

        return
      }

      if (noteTaking) {
        console.log(
          'NOTES ALREADY ACTIVE:',
          noteTranscript.length,
          'segments',
        )

        sendToG2({
          type:
            'notes_started',

          resumed:
            true,

          segments:
            noteTranscript.length,
        })

        return
      }

      noteTaking =
        true

      noteTranscript =
        []

      persistSessionState(
        true,
      )

      console.log(
        'NOTE TAKING STARTED',
      )

      sendToG2({
        type:
          'notes_started',

        resumed:
          false,

        segments:
          0,
      })
    }

    async function stopNotes() {
      console.log(
        'NOTES STOP REQUEST',
      )

      console.log(
        'NOTES SESSION:',
        clientSessionId ||
          'not-attached',
      )

      if (!storedSession) {
        sendToG2({
          type:
            'notes_error',

          text:
            'Session is not attached.',
        })

        return
      }

      if (!noteTaking) {
        console.log(
          'NOTES STOP IGNORED: not active',
        )

        sendToG2({
          type:
            'notes_error',

          text:
            'Notes were not recording.',
        })

        return
      }

      noteTaking =
        false

      persistSessionState(
        true,
      )

      sendToG2({
        type:
          'notes_processing',
      })

      const success =
        await generateNotes()

      if (success) {
        noteTranscript =
          []

        persistSessionState(
          true,
        )
      } else {
        // Keep the transcript so a save failure
        // does not destroy the lecture.
        persistSessionState(
          true,
        )

        console.log(
          'NOTE TRANSCRIPT PRESERVED AFTER SAVE FAILURE:',
          noteTranscript.length,
          'segments',
        )
      }
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

      const resets = [
        'new session',
        'reset session',
        'new context',
        'reset context',
        'change context',
        'new meeting',
        'new class',
      ]

      if (
        resets.some(
          command =>
            normalized.includes(
              command,
            ),
        )
      ) {
        await resetSession()

        return true
      }

      const aliases = {
        sales:
          'SALES',

        meeting:
          'MEETING',

        school:
          'SCHOOL',

        general:
          'GENERAL',
      }

      for (
        const [
          phrase,
          targetMode,
        ]
        of Object.entries(
          aliases,
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
          if (
            noteTaking
          ) {
            await stopNotes()
          }

          mode =
            targetMode

          clearLiveSessionState()

          persistSessionState(
            true,
          )

          sendToG2({
            type:
              'mode_changed',

            mode,
          })

          await sleep(
            100,
          )

          sendToG2({
            type:
              'session_reset',

            mode,
          })

          return true
        }
      }

      return false
    }

    // ==============================================
    // MANUAL ASK
    // ==============================================

    async function answerManualAsk(
      question,
    ) {
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

          max_tokens:
            650,

          system: `
Answer a direct smart-glasses question.

${modePrompt()}

Use session,
rolling memory,
and recent conversation.

Be concise.
Calculate carefully when needed.

Maximum 90 words.
`,

          messages: [
            {
              role:
                'user',

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

      manualAskBuffer =
        []

      if (question) {
        answerManualAsk(
          question,
        ).catch(
          console.error,
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

    // ==============================================
    // TRANSCRIPT
    // ==============================================

    function handleDeepgramMessage(
      data,
    ) {
      try {
        const message =
          JSON.parse(
            data.toString(),
          )

        const transcript =
          message.channel
            ?.alternatives?.[0]
            ?.transcript

        if (
          !transcript ||
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

          const count =
            noteTranscript.length

          if (
            count === 1 ||
            count % 10 === 0
          ) {
            console.log(
              'NOTE CAPTURE:',
              count,
              'segments',
            )
          }

          // Memory sync on every segment.
          persistSessionState()

          // Disk checkpoint every 10 segments.
          if (
            count === 1 ||
            count % 10 === 0
          ) {
            persistSessionState(
              true,
            )
          }
        }

        conversation.push(
          transcript,
        )

        transcriptRevision +=
          1

        persistSessionState()

        maybeInferSchoolTopic()
          .catch(
            console.error,
          )

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
    }

    // ==============================================
    // CONTROLS
    // ==============================================

    function handleControlMessage(
      payload,
    ) {
      if (
        payload.type ===
        'hello'
      ) {
        attachSession(
          payload,
        ).catch(error => {
          console.error(
            'Session attach error:',
            error,
          )

          sendToG2({
            type:
              'session_attach_error',

            text:
              'Could not restore session.',
          })
        })

        return
      }

      if (
        !storedSession
      ) {
        sendToG2({
          type:
            'session_attach_error',

          text:
            'Session not attached yet.',
        })

        return
      }

      storedSession.lastSeen =
        Date.now()

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

          persistSessionState(
            true,
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
        'set_context'
      ) {
        applyDirectContext(
          payload.context ||
            {},
        ).catch(error => {
          console.error(
            'Direct context error:',
            error,
          )

          sendToG2({
            type:
              'context_error',

            text:
              'Could not set context.',
          })
        })

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

        sessionContext =
          blankContext()

        persistSessionState(
          true,
        )

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

        manualAskBuffer =
          []

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
      }
    }

    // ==============================================
    // G2 SOCKET
    // ==============================================

    g2Socket.on(
      'message',
      (
        data,
        isBinary,
      ) => {
        if (!isBinary) {
          try {
            const text =
              Buffer.isBuffer(
                data,
              )
                ? data.toString(
                    'utf8',
                  )
                : String(
                    data,
                  )

            handleControlMessage(
              JSON.parse(
                text,
              ),
            )

            return
          } catch (error) {
            console.error(
              'Control message parse error:',
              error?.message ||
                error,
            )

            return
          }
        }

        if (
          isBinary &&
          storedSession
        ) {
          sendAudioToDeepgram(
            data,
          )
        }
      },
    )

    // ==============================================
    // DISCONNECT
    // ==============================================

    g2Socket.on(
      'close',
      () => {
        closingConnection =
          true

        persistSessionState(
          true,
        )

        console.log(
          'G2 DISCONNECTED',
        )

        console.log(
          'SESSION PRESERVED:',
          clientSessionId ||
            'not-attached',
        )

        console.log(
          'NOTES ACTIVE:',
          noteTaking,
        )

        console.log(
          'NOTES PRESERVED:',
          noteTranscript.length,
          'segments',
        )

        // IMPORTANT:
        // We DO NOT generate notes here.
        // Disconnect != end of lecture.

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

        stopDeepgram()
      },
    )

    g2Socket.on(
      'error',
      error => {
        console.error(
          'G2 socket error:',
          error?.message ||
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