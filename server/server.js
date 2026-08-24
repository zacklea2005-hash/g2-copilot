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
      accounts:
        parsed.accounts || {},

      entities:
        parsed.entities || {},
    }
  } catch {
    return {
      accounts: {},
      entities: {},
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
    'G2 Copilot JARVIS v8 running',
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '8.0',
    jarvis: true,
    numericalIntelligence: true,
    claimVerification: true,
    entityEnrichment: true,
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
    'NEW G2 JARVIS v8 SESSION',
  )

  console.log(
    '==============================\n',
  )

  let conversation = []
  let recentCards = []
  let recentClaims = []
  let recentEntities = []

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

  const MIN_RELEVANCE = 7
  const BUNDLE_COOLDOWN_MS = 10000
  const MAX_CONVERSATION_ITEMS = 60

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
- people
- companies
- products
- technologies
- places
- definitions
- acronyms
- corrections
- interesting connections
- current information
`
    }

    if (mode === 'MEETING') {
      return `
MEETING MODE

Act like a live chief of staff.

Prioritize:
- people/roles
- companies/vendors
- decisions
- commitments
- owners
- deadlines
- risks
- contradictions
- unresolved issues
- action items
`
    }

    if (mode === 'SCHOOL') {
      return `
SCHOOL MODE

Act like a proactive tutor.

Prioritize:
- concepts
- technologies
- acronyms
- definitions
- formulas
- people/theories when relevant
- examples
- professor emphasis
- misconceptions
`
    }

    return `
SALES MODE

Act like an elite technology AE copilot.

Prioritize:
- customers
- vendors
- executives
- products
- technologies
- competitors
- buying signals
- pain
- budget
- timeline
- renewals
- decision makers
- cloud
- cybersecurity
- AI
- licensing
- infrastructure
- data
`
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

        max_tokens: 800,

        system: `
You are the trigger engine for proactive smart glasses.

Do NOT generate the final HUD text.

${modePrompt()}

Detect important signals:

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

For entities, return the actual entity name.

Examples:

{
  "type": "COMPANY",
  "text": "Databricks"
}

{
  "type": "PERSON",
  "text": "Satya Nadella"
}

{
  "type": "PRODUCT",
  "text": "Microsoft Copilot"
}

{
  "type": "ACRONYM",
  "text": "MDR"
}

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
  // ENTITY ENRICHMENT
  // ==================================================

  async function enrichEntities(
    context,
    trigger,
  ) {
    if (
      trigger?.has_entities !== true
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

    if (entities.length === 0) {
      return {
        useful: false,
        entities: [],
      }
    }

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

    if (newEntities.length === 0) {
      return {
        useful: false,
        entities: [],
      }
    }

    const routeResponse =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 500,

        system: `
You decide which entities in a live conversation are worth enriching.

${modePrompt()}

For each entity, decide:

- relevance to the current moment
- whether current web research is needed
- what kind of context would actually help

Examples of useful enrichment:

COMPANY:
- what it does
- strategic position
- recent initiatives
- relevant competitor context
- acquisition/news if current

PERSON:
- role/title
- why they matter
- relevant company context

PRODUCT:
- what it does
- where it fits
- major competitor/differentiator

TECHNOLOGY:
- concise explanation
- why it matters in this context

ACRONYM:
- expansion
- concise meaning
- why it matters

Return ONLY valid JSON:

{
  "entities": [
    {
      "type": "COMPANY",
      "name": "Databricks",
      "relevance": 9,
      "research": true,
      "query": "Databricks latest company strategy AI lakehouse 2026",
      "need": "current company and competitive context"
    }
  ]
}

If no enrichment is useful:

{
  "entities": []
}

No markdown.
`,

        messages: [
          {
            role: 'user',

            content: `
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

    const route =
      parseClaudeJson(
        extractText(
          routeResponse,
        ),
      )

    const routed =
      Array.isArray(
        route?.entities,
      )
        ? route.entities
            .filter(
              entity =>
                Number(
                  entity.relevance ||
                    0,
                ) >= 7,
            )
            .slice(0, 3)
        : []

    if (routed.length === 0) {
      return {
        useful: false,
        entities: [],
      }
    }

    const enriched = []

    for (const entity of routed) {
      const key =
        `${entity.type}:${normalizedText(
          entity.name,
        )}`

      let researchText =
        'No live research performed.'

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
    (item, index) =>
      [
        `SOURCE ${index + 1}`,
        `Title: ${item.title || ''}`,
        `Content: ${item.content || ''}`,
      ].join('\n'),
  )
  .join('\n\n')}
`
        } catch (error) {
          console.error(
            'ENTITY RESEARCH ERROR:',
            error,
          )
        }
      }

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 500,

          system: `
You produce concise entity enrichment for smart glasses.

${modePrompt()}

The wearer does NOT want a biography or encyclopedia dump.

Give only information that helps with the current conversation.

Return ONLY valid JSON:

{
  "entity": "Databricks",
  "type": "COMPANY",
  "useful": true,
  "relevance": 9,
  "summary": "Databricks centers on lakehouse/data+AI workloads; key competitive overlap may include Snowflake, Fabric, and cloud-native analytics."
}

Rules:

- Max 35 words in summary.
- Use current research when supplied.
- Do not fabricate.
- For acronyms, expand the acronym.
- For a person, mention role only when confident.
- For a product, explain function + relevant context.
- If enrichment adds little, useful=false.
- No markdown.
`,

          messages: [
            {
              role: 'user',

              content: `
CONVERSATION:

${context}

ENTITY:

${JSON.stringify(
  entity,
)}

LIVE RESEARCH:

${researchText}
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
        parsed?.useful === true &&
        Number(
          parsed.relevance || 0,
        ) >= 7 &&
        parsed.summary
      ) {
        enriched.push(
          parsed,
        )

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
        recentEntities.slice(
          -40,
        )
    }

    saveMemory()

    console.log(
      'ENTITY ENRICHMENT:',
      JSON.stringify(
        enriched,
      ),
    )

    return {
      useful:
        enriched.length > 0,

      entities:
        enriched,
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

    return (
      parseClaudeJson(
        extractText(
          response,
        ),
      ) || {
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

            maxResults:
              6,

            includeAnswer:
              true,
          },
        )

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 900,

          system: `
Verify factual claims using supplied web research.

Classify each claim:

SUPPORTED
CONTRADICTED
MISLEADING
UNCERTAIN

Be conservative.

Do not call something false merely because evidence is missing.

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
          extractText(
            response,
          ),
        )

      for (
        const claim of
        unseenClaims
      ) {
        recentClaims.push(
          normalizedText(
            claim,
          ),
        )
      }

      if (
        recentClaims.length > 30
      ) {
        recentClaims =
          recentClaims.slice(
            -30,
          )
      }

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

      return `
SUMMARY:
${result.answer || 'None'}

RESULTS:
${JSON.stringify(
  result.results || [],
)}
`
    } catch {
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
You create compact HUD card bundles.

${modePrompt()}

You receive:
- trigger signals
- entity enrichment
- numerical intelligence
- claim verification
- optional live research

Return 1 to 3 cards.

Allowed:

KNOW_THIS
QUESTIONS
SAY_THIS

==================================================
ENTITY ENRICHMENT
==================================================

Use useful entity enrichment when it creates a real conversational advantage.

Example:

KNOW_THIS:
"Databricks is a lakehouse/data+AI platform; relevant overlap may include Snowflake, Fabric, and cloud-native analytics."

Do NOT show entity trivia just because an entity was mentioned.

==================================================
CLAIMS
==================================================

For CONTRADICTED or MISLEADING claims with confidence >= 8 and worth_interrupting=true, consider a concise neutral correction.

==================================================
NUMBERS
==================================================

If the numerical engine produced something materially useful, consider showing the strongest calculation.

==================================================
MODE BEHAVIOR
==================================================

SALES:
Prefer KNOW_THIS → QUESTIONS → SAY_THIS

MEETING:
Prefer KNOW_THIS → QUESTIONS → SAY_THIS

SCHOOL:
Prefer KNOW_THIS explanation → KNOW_THIS connection → QUESTIONS

GENERAL:
Prefer KNOW_THIS fact/context → KNOW_THIS connection → SAY_THIS/QUESTIONS if useful

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
No repetition.
No fabricated facts.
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
  // CARD UTILS
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
      noteTranscript.length === 0
    ) {
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

Turn the transcript into polished, highly understandable notes.

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

EVERY note MUST end with:

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
    }
  }

  function startNotes() {
    if (noteTaking) {
      return
    }

    noteTaking = true
    noteTranscript = []

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

Use the conversation context.

If the question asks about a person, company, product, acronym, or technology, explain the entity concisely and in context.

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
  // TRANSCRIPT
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
      `G2 JARVIS v8 running on port ${PORT}`,
    )
  },
)