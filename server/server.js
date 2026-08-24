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

const ACCOUNT_CACHE_MAX_AGE_MS =
  24 * 60 * 60 * 1000

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
      accounts:
        parsed.accounts || {},
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

function escapeDriveQuery(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
}

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    'G2 Copilot JARVIS v7 running',
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '7.0',
    jarvis: true,
    numericalIntelligence: true,
    claimVerification: true,
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
      drive,
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

        body:
          html,
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
    'NEW G2 JARVIS v7 SESSION',
  )

  console.log(
    '==============================\n',
  )

  let conversation = []
  let recentCards = []
  let recentClaims = []

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
  // MODE
  // ==================================================

  function modePrompt() {
    if (mode === 'GENERAL') {
      return `
GENERAL MODE

Act like a proactive everyday JARVIS.

Prioritize:
- useful facts
- context
- names
- companies
- products
- places
- corrections
- definitions
- interesting connections
- numerical implications
- claims worth checking
- current information
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
- contradictions
- unresolved issues
- action items
- next steps
- claims that affect decisions
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
- professor emphasis
- conceptual connections
- numerical reasoning
- factual claims
- misconceptions
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
- vendor dissatisfaction
- cloud
- cybersecurity
- AI
- licensing
- infrastructure
- data
- hardware
- competitors
- objections
- next-best action
- useful calculations
- factual vendor/product claims
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

        max_tokens: 700,

        system: `
You are the trigger engine for proactive smart glasses.

Do NOT generate final HUD text.

${modePrompt()}

Detect important signal types:

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

A CLAIM means a factual statement that could potentially be true, false, misleading, outdated, overly broad, or worth verifying.

Examples:

"Microsoft bought Wiz."
"Azure is always cheaper than AWS."
"ServiceNow acquired company X."
"The renewal increased 30%."
"Company X's CEO is Jane Doe."

Do NOT fact-check:
- opinions
- preferences
- subjective statements
- obvious conversational filler

Return ONLY valid JSON:

{
  "interrupt": true,
  "relevance": 9,
  "signals": [
    {
      "type": "CLAIM",
      "text": "Microsoft bought Wiz"
    }
  ],
  "has_numbers": false,
  "has_claims": true,
  "research": true,
  "research_query": "Microsoft Wiz acquisition"
}

No useful signal:

{
  "interrupt": false,
  "relevance": 0,
  "signals": [],
  "has_numbers": false,
  "has_claims": false,
  "research": false,
  "research_query": ""
}

No markdown.
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
  // NUMERICAL INTELLIGENCE
  // ==================================================

  async function analyzeNumbers(
    context,
    trigger,
  ) {
    if (
      trigger?.has_numbers !== true
    ) {
      return {
        useful: false,
        relevance: 0,
        calculations: [],
        summary: '',
      }
    }

    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 650,

        system: `
You are the numerical intelligence engine for smart glasses.

Extract meaningful numbers and calculate useful implications.

Examples:

8000 × $42/month
= $336K/month
= $4.032M/year

18% off $2.4M
= $432K savings
= $1.968M final price

Do not guess missing values.

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

    const parsed =
      parseClaudeJson(
        extractText(response),
      )

    return (
      parsed || {
        useful: false,
        relevance: 0,
        calculations: [],
        summary: '',
      }
    )
  }

  // ==================================================
  // CLAIM VERIFICATION
  // ==================================================

  async function verifyClaims(
    context,
    trigger,
  ) {
    if (
      trigger?.has_claims !== true
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
        .map(signal =>
          String(
            signal.text || '',
          ).trim(),
        )
        .filter(Boolean)
        .slice(0, 3)

    if (claims.length === 0) {
      return {
        checked: false,
        claims: [],
      }
    }

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

    const query =
      unseenClaims.join(' OR ')

    console.log(
      'FACT CHECK SEARCH:',
      query,
    )

    try {
      const search =
        await tvly.search(
          query,
          {
            searchDepth:
              'advanced',

            maxResults:
              6,

            includeAnswer:
              true,
          },
        )

      const sources =
        (search.results || [])
          .slice(0, 6)
          .map(
            (
              item,
              index,
            ) => ({
              index:
                index + 1,

              title:
                item.title || '',

              url:
                item.url || '',

              content:
                item.content || '',
            }),
          )

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 900,

          system: `
You verify factual claims using supplied web research.

Classify each claim as exactly one:

SUPPORTED
CONTRADICTED
MISLEADING
UNCERTAIN

Definitions:

SUPPORTED:
Reliable evidence strongly supports it.

CONTRADICTED:
Reliable evidence clearly shows it is false.

MISLEADING:
There is some truth, but important context makes the statement materially misleading or overly broad.

UNCERTAIN:
Evidence is insufficient, conflicting, ambiguous, or outdated.

IMPORTANT RULES:

- Be conservative.
- Do not mark a claim false merely because you did not find evidence.
- Prefer primary or highly credible sources when present.
- Current claims require current evidence.
- Never invent evidence.
- Only recommend interrupting the wearer if the correction materially matters.
- Avoid pedantic corrections.

Return ONLY valid JSON:

{
  "checked": true,
  "claims": [
    {
      "claim": "Microsoft bought Wiz",
      "verdict": "CONTRADICTED",
      "confidence": 9,
      "correction": "Google announced an agreement to acquire Wiz, not Microsoft.",
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
CONVERSATION:

${context}

CLAIMS:

${JSON.stringify(
  unseenClaims,
)}

SEARCH ANSWER:

${search.answer || 'None'}

SEARCH SOURCES:

${JSON.stringify(
  sources,
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

      console.log(
        'CLAIM VERIFICATION:',
        JSON.stringify(parsed),
      )

      return (
        parsed || {
          checked: false,
          claims: [],
        }
      )
    } catch (error) {
      console.error(
        'CLAIM VERIFICATION ERROR:',
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
        'No additional live research performed.'
      )
    }

    try {
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
        (result.results || [])
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
        'Research error:',
        error,
      )

      return (
        'Live research failed.'
      )
    }
  }

  // ==================================================
  // CARD BUNDLES
  // ==================================================

  async function generateBundle(
    context,
    trigger,
    numericalIntel,
    verification,
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

        max_tokens: 1100,

        system: `
You create compact HUD card bundles.

${modePrompt()}

Return 1 to 3 cards.

Allowed card types:

KNOW_THIS
QUESTIONS
SAY_THIS

==================================================
FACT CHECKING
==================================================

You may receive verified claims.

If a claim is:

CONTRADICTED
or
MISLEADING

AND:
- confidence is at least 8
- worth_interrupting is true

then strongly consider a KNOW_THIS correction.

Examples:

KNOW_THIS:
"Correction: Google—not Microsoft—announced the Wiz acquisition."

Do NOT surface UNCERTAIN claims as corrections.

For SUPPORTED claims, only surface confirmation if it is actually useful.

Never embarrass or attack the speaker.

Prefer concise neutral phrasing:

"Correction:"
"Context:"
"Worth noting:"

==================================================
NUMERICAL INTELLIGENCE
==================================================

If useful calculations exist, consider a KNOW_THIS card with the most important implication.

==================================================
SALES
==================================================

Prefer:
1. KNOW_THIS
2. QUESTIONS
3. SAY_THIS

==================================================
MEETING
==================================================

Prefer:
1. KNOW_THIS — risk/decision/correction
2. QUESTIONS
3. SAY_THIS

==================================================
SCHOOL
==================================================

Prefer:
1. KNOW_THIS — explanation/correction
2. KNOW_THIS — useful connection
3. QUESTIONS

==================================================
GENERAL
==================================================

Prefer:
1. KNOW_THIS — fact/correction/context
2. KNOW_THIS — useful connection
3. SAY_THIS or QUESTIONS if useful

==================================================

KNOW_THIS:
max 25 words

SAY_THIS:
max 22 words

QUESTIONS:
2 or 3 questions
max 13 words each

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
Minimum relevance 7.
Do not repeat recent cards.
Do not fabricate facts.
No markdown.
`,

        messages: [
          {
            role: 'user',

            content: `
CONVERSATION:

${context}

TRIGGER:

${JSON.stringify(trigger)}

NUMERICAL INTELLIGENCE:

${JSON.stringify(
  numericalIntel,
)}

CLAIM VERIFICATION:

${JSON.stringify(
  verification,
)}

OTHER LIVE RESEARCH:

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
  // CARD UTILITIES
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
        (card.questions || [])
          .join(' '),
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

      recentCards.push(card)

      console.log(
        'JARVIS CARD SENT:',
        card.type,
        JSON.stringify(card),
      )
    }

    if (
      recentCards.length > 20
    ) {
      recentCards =
        recentCards.slice(-20)
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
            console.log(
              'JARVIS cooldown active',
            )

            analyzedRevision =
              targetRevision

            continue
          }

          const [
            numericalIntel,
            verification,
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
    if (mode === 'SCHOOL') {
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
  // NOTES
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
            type: 'notes_error',

            text:
              'No speech was captured.',
          }),
        )
      }

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

          max_tokens: 5000,

          system: `
You are an expert AI note taker.

Turn this transcript into polished, highly understandable notes.

MODE:
${mode}

Remove filler and repetition.
Do not invent information.
Organize by topic.

SCHOOL:
Include concepts, definitions, formulas, examples, professor emphasis, likely testable material, misconceptions, questions and key takeaways.

MEETING:
Include executive summary, discussion, decisions, action items, owners, deadlines, risks, open questions and follow-ups.

SALES:
Include executive summary, customer situation, pain points, technical environment, buying signals, opportunities, competitors, objections, budget, timeline, stakeholders, next steps and follow-up questions.

GENERAL:
Organize the important ideas clearly.

If factual claims appeared in the conversation, do NOT silently rewrite questionable claims as established truth.

When useful, label them as:
- Confirmed
- Unverified
- Potentially inaccurate

==================================================
MANDATORY ENDING
==================================================

Every note MUST end with:

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

Explain important calculations clearly.

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
              parsed.summary || '',

            url:
              doc.webViewLink || '',
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
            type: 'notes_error',

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
        type: 'notes_started',
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
        model: 'claude-sonnet-5',

        max_tokens: 500,

        system: `
You are answering a direct smart-glasses question.

${modePrompt()}

Use conversation context when relevant.

If the user asks whether a claim is true, be careful about certainty and distinguish known information from uncertainty.

Maximum 70 words.

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
      extractText(response)

    if (
      g2Socket.readyState ===
      WebSocket.OPEN
    ) {
      g2Socket.send(
        JSON.stringify({
          type:
            'manual_answer',

          text: answer,
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
      `G2 JARVIS v7 running on port ${PORT}`,
    )
  },
)