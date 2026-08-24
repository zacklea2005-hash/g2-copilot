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
// GOOGLE
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

const ACCOUNT_CACHE_MAX_AGE_MS =
  24 * 60 * 60 * 1000

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, { recursive: true })
}

// ==================================================
// MEMORY
// ==================================================

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
  } catch {
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

function safeFilename(value) {
  return String(value || 'G2 Notes')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

function escapeDriveQuery(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    'G2 Copilot JARVIS + Notes running',
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '5.0',
    jarvis: true,
    bundles: true,
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
    `trashed = false`,
    parentId
      ? `'${parentId}' in parents`
      : `'root' in parents`,
  ].join(' and ')

  const result =
    await drive.files.list({
      q: query,
      fields: 'files(id,name)',
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
    route.area === 'GENERAL'
  ) {
    const folder =
      await findFolder(
        drive,
        'General',
        root,
      )

    return {
      drive,
      folder,
      path:
        'G2 Copilot / General',
    }
  }

  if (
    route.area === 'WORK'
  ) {
    const folder =
      await findFolder(
        drive,
        'Work',
        root,
      )

    return {
      drive,
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
      drive,
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
    drive,
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
      max_tokens: 160,

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
// G2 SESSION
// ==================================================

wss.on('connection', g2Socket => {
  console.log(
    '\n==============================',
  )
  console.log(
    'NEW G2 JARVIS SESSION',
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

  let lastBundleAt = 0

  let manualAskActive = false
  let manualAskBuffer = []
  let manualAskTimer = null

  let noteTaking = false
  let noteTranscript = []
  let noteStartedAt = null

  const MIN_RELEVANCE = 7

  // Faster than before, but still prevents spam.
  const BUNDLE_COOLDOWN_MS =
    10000

  const MAX_CONVERSATION_ITEMS =
    60

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
  // MODE INTELLIGENCE
  // ==================================================

  function modePrompt() {
    if (mode === 'GENERAL') {
      return `
GENERAL MODE

Act like a proactive everyday JARVIS.

Prioritize:
- useful facts
- names
- companies
- products
- places
- numerical implications
- corrections
- definitions
- current information
- claims worth checking
- helpful responses
- interesting connections
`
    }

    if (mode === 'MEETING') {
      return `
MEETING MODE

Act like a live chief of staff.

Prioritize:
- decisions
- unresolved questions
- commitments
- owners
- deadlines
- risks
- contradictions
- missing information
- action items
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
- claims worth clarifying
- professor emphasis
- likely testable material
- conceptual connections
- useful questions
`
    }

    return `
SALES MODE

Act like an elite technology AE copilot.

Prioritize:
- buying signals
- pain
- budget
- timeline
- renewals
- decision makers
- economic buyer
- incumbent vendors
- dissatisfaction
- migrations
- security concerns
- AI initiatives
- cloud
- licensing
- cybersecurity
- hardware
- data
- competitors
- objections
- next-best actions
- strong discovery questions
`
  }

  // ==================================================
  // JARVIS TRIGGER ENGINE
  // ==================================================

  async function analyzeMoment(
    context,
  ) {
    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 600,

        system: `
You are the trigger engine for proactive smart glasses.

Your job is NOT to produce the final HUD response.

Analyze the newest conversation and identify whether anything is important enough to interrupt the wearer.

${modePrompt()}

Detect these signal types:

ENTITY
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
TECHNICAL_CONCEPT
CURRENT_INFO
NO_SIGNAL

A signal may require research.

Research is useful when the answer depends on:
- current company information
- current executives
- recent news
- acquisitions
- current products
- current pricing
- current partnerships
- recent security events
- statistics that may have changed
- factual claims that should be verified

Return ONLY valid JSON:

{
  "interrupt": true,
  "relevance": 9,
  "signals": [
    {
      "type": "BUYING_SIGNAL",
      "text": "Microsoft agreement renews in November"
    },
    {
      "type": "NUMBER",
      "text": "Cloud spend increased 30%"
    }
  ],
  "research": true,
  "research_query": "current relevant search query",
  "reason": "short internal classification"
}

If nothing deserves attention:

{
  "interrupt": false,
  "relevance": 0,
  "signals": [],
  "research": false,
  "research_query": "",
  "reason": ""
}

Do not use markdown.
`,

        messages: [
          {
            role: 'user',
            content: `
RECENT CONVERSATION:

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
  // OPTIONAL LIVE RESEARCH
  // ==================================================

  async function researchSignal(
    trigger,
  ) {
    if (
      !trigger?.research ||
      !trigger?.research_query
    ) {
      return (
        'No live research performed.'
      )
    }

    try {
      console.log(
        'JARVIS RESEARCH:',
        trigger.research_query,
      )

      const result =
        await tvly.search(
          trigger.research_query,
          {
            searchDepth:
              'basic',

            maxResults:
              5,

            includeAnswer:
              true,
          },
        )

      const results =
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
              ].join('\n'),
          )
          .join('\n\n')

      return `
LIVE RESEARCH SUMMARY:
${result.answer || 'None'}

RESULTS:
${results}
`
    } catch (error) {
      console.error(
        'JARVIS RESEARCH ERROR:',
        error,
      )

      return (
        'Live research failed.'
      )
    }
  }

  // ==================================================
  // CARD BUNDLE GENERATOR
  // ==================================================

  async function generateBundle(
    context,
    trigger,
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
                card.questions ||
                []
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

        max_tokens: 900,

        system: `
You create compact card bundles for smart glasses.

${modePrompt()}

You receive:
- recent conversation
- detected signals
- optional live research

Return 1 to 3 cards.

Possible card types:

KNOW_THIS
QUESTIONS
SAY_THIS

The bundle should be intentionally useful, not repetitive.

==================================================
SALES
==================================================

For a strong sales moment, prefer:

1. KNOW_THIS
2. QUESTIONS
3. SAY_THIS

But only include cards that genuinely help.

KNOW_THIS examples:
- buying signal
- account intelligence
- competitive context
- opportunity
- risk

QUESTIONS:
Give 2 or 3 concise discovery questions.

SAY_THIS:
Give one short line the wearer could naturally say.

==================================================
MEETING
==================================================

Prefer:
1. KNOW_THIS for decision/risk
2. QUESTIONS for unresolved issues
3. SAY_THIS for a useful next-step statement

==================================================
SCHOOL
==================================================

Prefer:
1. KNOW_THIS for explanation/concept
2. KNOW_THIS for connection/example if useful
3. QUESTIONS for useful questions to ask

Do not make School mode sound like sales.

==================================================
GENERAL
==================================================

Prefer:
1. KNOW_THIS for fact/context
2. KNOW_THIS for connection/current information
3. SAY_THIS or QUESTIONS only when useful

==================================================

HUD rules:

KNOW_THIS:
maximum 25 words

SAY_THIS:
maximum 22 words

QUESTIONS:
2 or 3 questions
each maximum 13 words

Return ONLY valid JSON:

{
  "cards": [
    {
      "type": "KNOW_THIS",
      "relevance": 9,
      "body": "..."
    },
    {
      "type": "QUESTIONS",
      "relevance": 9,
      "questions": [
        "...",
        "...",
        "..."
      ]
    },
    {
      "type": "SAY_THIS",
      "relevance": 8,
      "body": "..."
    }
  ]
}

Rules:

- Maximum 3 cards.
- Minimum relevance 7.
- Do not repeat recent cards.
- Do not fabricate research facts.
- If only one card is useful, return one.
- If nothing useful remains, return {"cards":[]}.
- No markdown.
`,

        messages: [
          {
            role: 'user',

            content: `
CONVERSATION:

${context}

TRIGGER ANALYSIS:

${JSON.stringify(trigger)}

LIVE RESEARCH:

${research}

RECENT CARDS ALREADY SHOWN:

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
  // SEND BUNDLE
  // ==================================================

  function normalizeCard(card) {
    if (!card) {
      return null
    }

    const relevance =
      Number(card.relevance || 0)

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
        type: 'QUESTIONS',
        relevance,
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
        body,
      }
    }

    return null
  }

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

  function isDuplicateCard(
    card,
  ) {
    const signature =
      cardSignature(card)

    return recentCards.some(
      old => {
        const oldSignature =
          cardSignature(old)

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

  function sendBundle(
    cards,
  ) {
    const cleanCards =
      cards
        .map(
          normalizeCard,
        )
        .filter(Boolean)
        .filter(
          card =>
            !isDuplicateCard(
              card,
            ),
        )
        .slice(0, 3)

    if (
      cleanCards.length ===
      0
    ) {
      console.log(
        'JARVIS: no usable cards',
      )
      return
    }

    if (
      g2Socket.readyState !==
      WebSocket.OPEN
    ) {
      return
    }

    // Existing main.ts understands individual "card" messages,
    // so send them one after another.
    for (
      const card of
      cleanCards
    ) {
      g2Socket.send(
        JSON.stringify({
          type: 'card',
          card,
        }),
      )

      recentCards.push(
        card,
      )

      console.log(
        'JARVIS CARD SENT:',
        card.type,
      )
    }

    if (
      recentCards.length >
      20
    ) {
      recentCards =
        recentCards.slice(-20)
    }

    lastBundleAt =
      Date.now()
  }

  // ==================================================
  // JARVIS ANALYSIS LOOP
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
            trigger.interrupt !==
              true ||
            Number(
              trigger.relevance ||
                0,
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
            console.log(
              'JARVIS cooldown active',
            )

            analyzedRevision =
              targetRevision
            continue
          }

          const research =
            await researchSignal(
              trigger,
            )

          const bundle =
            await generateBundle(
              context,
              trigger,
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
        !manualAskActive
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
    if (
      mode === 'SCHOOL'
    ) {
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
  // NOTES GENERATOR
  // ==================================================

  async function generateNotes() {
    if (
      noteTranscript.length ===
      0
    ) {
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

    try {
      const route =
        await determineNoteRoute(
          transcript,
        )

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            5000,

          system: `
You are an expert AI note taker.

Turn the transcript into highly organized, polished notes.

MODE:
${mode}

Remove filler and repetition.
Do not invent facts.
Organize by topic.

SCHOOL:
Include concepts, definitions, formulas, examples, professor emphasis, likely testable material, common mistakes, questions and key takeaways.

MEETING:
Include executive summary, discussion, decisions, action items, owners, deadlines, risks, open questions and follow-ups.

SALES:
Include executive summary, customer situation, pain points, technical environment, buying signals, opportunities, competitors, objections, budget, timeline, stakeholders, next steps and follow-up questions.

GENERAL:
Organize the important ideas clearly.

EVERY NOTE MUST END WITH:

AI SUMMARY & EXPLANATION

Include:

1. Plain-English Summary
2. What This Really Means
3. Most Important Things to Remember
4. Connections

SCHOOL also:
5. How to Study This

SALES/MEETING also:
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
          extractText(
            response,
          ),
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

      if (
        g2Socket.readyState ===
        WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
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
          }),
        )
      }
    } catch (error) {
      console.error(
        'NOTE SAVE ERROR:',
        error,
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
              'Could not save notes.',
          }),
        )
      }
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

    g2Socket.send(
      JSON.stringify({
        type:
          'notes_started',
      }),
    )
  }

  async function stopNotes() {
    if (!noteTaking) {
      return
    }

    noteTaking = false

    g2Socket.send(
      JSON.stringify({
        type:
          'notes_processing',
      }),
    )

    await generateNotes()

    noteTranscript = []
    noteStartedAt = null
  }

  // ==================================================
  // MANUAL ASK
  // ==================================================

  async function answerManualAsk(
    question,
  ) {
    const response =
      await anthropic.messages.create({
        model:
          'claude-sonnet-5',

        max_tokens:
          400,

        system: `
You are answering a direct smart-glasses question.

${modePrompt()}

Use conversation context when relevant.

Maximum 60 words.

If the user asks for options, give up to 3.

Be direct.
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
    }
  }

  function finishManualAsk() {
    if (!manualAskActive) {
      return
    }

    if (manualAskTimer) {
      clearTimeout(
        manualAskTimer,
      )
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
      )
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
  // TRANSCRIPTS
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

        if (noteTaking) {
          noteTranscript.push(
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
  // CONTROLS
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
        Buffer.isBuffer(data)
      ) {
        const text =
          data.toString(
            'utf8',
          )

        if (
          text.startsWith('{')
        ) {
          try {
            handleControlMessage(
              JSON.parse(text),
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
        deepgramSocket.send(
          data,
        )
      }
    },
  )

  g2Socket.on(
    'close',
    () => {
      if (
        noteTaking &&
        noteTranscript.length >
          0
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
      `G2 JARVIS v5 running on port ${PORT}`,
    )
  },
)