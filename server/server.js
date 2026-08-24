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

const driveFolderCache =
  new Map()

// ==================================================
// LOCAL STORAGE
// ==================================================

const DATA_DIR =
  path.join(
    __dirname,
    'data',
  )

const NOTES_DIR =
  path.join(
    DATA_DIR,
    'notes',
  )

const MEMORY_FILE =
  path.join(
    DATA_DIR,
    'memory.json',
  )

const ACCOUNT_CACHE_MAX_AGE_MS =
  24 * 60 * 60 * 1000

if (
  !fs.existsSync(
    DATA_DIR,
  )
) {
  fs.mkdirSync(
    DATA_DIR,
    {
      recursive: true,
    },
  )
}

if (
  !fs.existsSync(
    NOTES_DIR,
  )
) {
  fs.mkdirSync(
    NOTES_DIR,
    {
      recursive: true,
    },
  )
}

// ==================================================
// MEMORY
// ==================================================

function loadMemory() {
  try {
    if (
      !fs.existsSync(
        MEMORY_FILE,
      )
    ) {
      return {
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
      accounts:
        parsed.accounts ||
        {},
    }
  } catch {
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
  return String(
    raw || '',
  )
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
      item =>
        item.text,
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
    const firstBrace =
      cleaned.indexOf(
        '{',
      )

    const lastBrace =
      cleaned.lastIndexOf(
        '}',
      )

    if (
      firstBrace !== -1 &&
      lastBrace !== -1 &&
      lastBrace >
        firstBrace
    ) {
      try {
        return JSON.parse(
          cleaned.slice(
            firstBrace,
            lastBrace +
              1,
          ),
        )
      } catch {
        return null
      }
    }

    return null
  }
}

function safeFilename(
  value,
) {
  return String(
    value ||
      'G2 Notes',
  )
    .replace(
      /[^\w\s-]/g,
      '',
    )
    .replace(
      /\s+/g,
      '-',
    )
    .replace(
      /-+/g,
      '-',
    )
    .slice(
      0,
      80,
    )
}

function escapeDriveQuery(
  value,
) {
  return String(
    value,
  )
    .replace(
      /\\/g,
      '\\\\',
    )
    .replace(
      /'/g,
      "\\'",
    )
}

// ==================================================
// HTTP
// ==================================================

app.get(
  '/',
  (req, res) => {
    res.send(
      'G2 Copilot JARVIS v6 running',
    )
  },
)

app.get(
  '/health',
  (req, res) => {
    res.json({
      status: 'ok',
      version: '6.0',
      jarvis: true,
      bundles: true,
      numericalIntelligence:
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
// GOOGLE AUTH
// ==================================================

app.get(
  '/google/auth',
  (req, res) => {
    const client =
      createGoogleOAuthClient()

    const authUrl =
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

    res.redirect(
      authUrl,
    )
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
          'GOOGLE_REFRESH_TOKEN:',
          tokens.refresh_token,
        )
      }

      res.send(
        'G2 Copilot Google Drive connected. You can close this page.',
      )
    } catch (
      error
    ) {
      console.error(
        'Google OAuth error:',
        error,
      )

      res
        .status(
          500,
        )
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
    escapeDriveQuery(
      name,
    )

  const query = [
    `name = '${escapedName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
    parentId
      ? `'${parentId}' in parents`
      : `'root' in parents`,
  ].join(
    ' and ',
  )

  const result =
    await drive.files.list({
      q: query,
      fields:
        'files(id,name)',
      pageSize:
        20,
    })

  const folder =
    result.data
      .files?.[0]

  if (
    !folder?.id
  ) {
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
      drive,
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

  if (
    !route.course
  ) {
    return {
      drive,
      folder:
        school,
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
    folder:
      course,
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
        name:
          title,

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
      model:
        'claude-sonnet-5',

      max_tokens:
        160,

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
          role:
            'user',
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

  const allowed =
    [
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
      parsed?.confidence ||
        0,
    ) >= 6
  ) {
    return parsed.course
  }

  return null
}

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
      'NEW G2 JARVIS v6 SESSION',
    )

    console.log(
      '==============================\n',
    )

    let conversation =
      []

    let recentCards =
      []

    let mode =
      'SALES'

    let analyzing =
      false

    let transcriptRevision =
      0

    let analyzedRevision =
      0

    let lastBundleAt =
      0

    let manualAskActive =
      false

    let manualAskBuffer =
      []

    let manualAskTimer =
      null

    let noteTaking =
      false

    let noteTranscript =
      []

    let noteStartedAt =
      null

    const MIN_RELEVANCE =
      7

    const BUNDLE_COOLDOWN_MS =
      10000

    const MAX_CONVERSATION_ITEMS =
      60

    // ==================================================
    // DEEPGRAM
    // ==================================================

    const params =
      new URLSearchParams({
        model:
          'nova-3',

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
      if (
        mode ===
        'GENERAL'
      ) {
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
- useful responses
- interesting connections
`
      }

      if (
        mode ===
        'MEETING'
      ) {
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
- missing information
- action items
- unresolved questions
- next steps
- financial or numerical implications
`
      }

      if (
        mode ===
        'SCHOOL'
      ) {
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
- likely testable material
- conceptual connections
- useful questions
- numerical reasoning
- statistical implications
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
- useful calculations
- pricing implications
- savings
- annualized spend
- per-user economics
- ROI
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
          model:
            'claude-sonnet-5',

          max_tokens:
            650,

          system: `
You are the trigger engine for proactive smart glasses.

Do NOT produce the final HUD response.

Analyze the newest conversation and decide whether anything is useful enough to interrupt the wearer.

${modePrompt()}

Detect:

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

NUMBERS are especially important when they imply:
- money
- savings
- costs
- revenue
- growth
- percentages
- licenses
- users
- devices
- quantities
- dates
- deadlines
- ROI
- probability
- statistics
- comparisons
- monthly vs annual spend

Research may be useful for facts that depend on current external information.

Return ONLY valid JSON:

{
  "interrupt": true,
  "relevance": 9,
  "signals": [
    {
      "type": "NUMBER",
      "text": "8,000 users at $42/user/month"
    }
  ],
  "has_numbers": true,
  "research": false,
  "research_query": ""
}

No signal:

{
  "interrupt": false,
  "relevance": 0,
  "signals": [],
  "has_numbers": false,
  "research": false,
  "research_query": ""
}

No markdown.
`,

          messages: [
            {
              role:
                'user',

              content: `
RECENT CONVERSATION:

${context}
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

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            650,

          system: `
You are the numerical intelligence engine for smart glasses.

Extract the meaningful numbers in the conversation and calculate useful implications.

Focus on relationships that are immediately useful.

Examples:

8,000 users × $42/user/month
= $336,000/month
= $4,032,000/year

18% discount on $2.4M
= $432,000 savings
= $1,968,000 final price

$250K/month cloud spend rising 20%
= $300K/month
= $600K additional annual spend

A 90-day deadline beginning September 1
= approximately November 30.

Rules:

- Only calculate when the relationship is supported by the conversation.
- Do not guess missing numbers.
- Do not invent assumptions unless clearly labeled.
- Prefer exact arithmetic when possible.
- Round sensibly for HUD use.
- Highlight business, statistical, financial, or timeline significance.
- If the numbers are trivial or not useful, return useful=false.

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
  "summary": "At 8,000 users, $42/user/month equals about $4.03M annually."
}

If no useful calculation:

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
              role:
                'user',

              content: `
CONVERSATION:

${context}

DETECTED SIGNALS:

${JSON.stringify(
  trigger?.signals ||
    [],
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

      if (!parsed) {
        return {
          useful: false,
          relevance: 0,
          calculations: [],
          summary: '',
        }
      }

      console.log(
        'NUMERICAL INTELLIGENCE:',
        JSON.stringify(
          parsed,
        ),
      )

      return parsed
    }

    // ==================================================
    // OPTIONAL LIVE RESEARCH
    // ==================================================

    async function researchSignal(
      trigger,
    ) {
      if (
        !trigger?.research ||
        !trigger
          ?.research_query
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
            .slice(
              0,
              5,
            )
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

        return `
LIVE RESEARCH SUMMARY:
${result.answer || 'None'}

RESULTS:
${results}
`
      } catch (
        error
      ) {
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
      numericalIntel,
      research,
    ) {
      const recent =
        recentCards
          .slice(
            -10,
          )
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

              return (
                `${card.type}: ` +
                `${card.body || ''}`
              )
            },
          )
          .join(
            '\n',
          )

      const response =
        await anthropic.messages.create({
          model:
            'claude-sonnet-5',

          max_tokens:
            1000,

          system: `
You create compact card bundles for smart glasses.

${modePrompt()}

You receive:
- conversation
- trigger analysis
- numerical intelligence
- optional live research

Return 1 to 3 cards.

Card types:

KNOW_THIS
QUESTIONS
SAY_THIS

==================================================
NUMERICAL INTELLIGENCE
==================================================

When the numerical engine produced a useful calculation, strongly consider a KNOW_THIS card containing the most valuable calculation.

Example:

{
  "type": "KNOW_THIS",
  "relevance": 10,
  "body": "8,000 users at $42/month equals about $4.03M annually."
}

Do not clutter the HUD with trivial arithmetic.

==================================================
SALES
==================================================

For a strong sales moment, usually prefer:

1. KNOW_THIS — implication / buying signal / useful math
2. QUESTIONS — discovery
3. SAY_THIS — natural next statement

==================================================
MEETING
==================================================

Prefer:
1. KNOW_THIS — decision/risk/numeric implication
2. QUESTIONS — unresolved issues
3. SAY_THIS — next-step statement

==================================================
SCHOOL
==================================================

Prefer:
1. KNOW_THIS — concept/explanation
2. KNOW_THIS — calculation or connection
3. QUESTIONS — questions worth asking

==================================================
GENERAL
==================================================

Prefer:
1. KNOW_THIS — useful fact/math
2. KNOW_THIS — context
3. SAY_THIS or QUESTIONS when useful

==================================================
HUD LIMITS
==================================================

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
              role:
                'user',

              content: `
CONVERSATION:

${context}

TRIGGER:

${JSON.stringify(
  trigger,
)}

NUMERICAL INTELLIGENCE:

${JSON.stringify(
  numericalIntel,
)}

LIVE RESEARCH:

${research}

RECENT CARDS:

${recent || 'None'}
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
    // CARD NORMALIZATION
    // ==================================================

    function normalizeCard(
      card,
    ) {
      if (!card) {
        return null
      }

      const relevance =
        Number(
          card.relevance ||
            0,
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
                    String(
                      q,
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
          return null
        }

        return {
          type:
            'QUESTIONS',

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
          .replace(
            /\s+/g,
            ' ',
          )
          .trim()
      }

      return String(
        card.body ||
          '',
      )
        .toLowerCase()
        .replace(
          /\s+/g,
          ' ',
        )
        .trim()
    }

    function isDuplicateCard(
      card,
    ) {
      const signature =
        cardSignature(
          card,
        )

      return recentCards.some(
        old => {
          const oldSignature =
            cardSignature(
              old,
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

    function sendBundle(
      cards,
    ) {
      const cleanCards =
        cards
          .map(
            normalizeCard,
          )
          .filter(
            Boolean,
          )
          .filter(
            card =>
              !isDuplicateCard(
                card,
              ),
          )
          .slice(
            0,
            3,
          )

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

      for (
        const card of
        cleanCards
      ) {
        g2Socket.send(
          JSON.stringify({
            type:
              'card',

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
          recentCards.slice(
            -20,
          )
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

      analyzing =
        true

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

            // Numerical analysis and web research
            // can happen independently.
            const [
              numericalIntel,
              research,
            ] =
              await Promise.all([
                analyzeNumbers(
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
          } catch (
            error
          ) {
            console.error(
              'JARVIS ANALYSIS ERROR:',
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
    // NOTES ROUTING
    // ==================================================

    async function determineNoteRoute(
      transcript,
    ) {
      if (
        mode ===
        'SCHOOL'
      ) {
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
        mode ===
          'SALES' ||
        mode ===
          'MEETING'
      ) {
        return {
          area:
            'WORK',

          course:
            null,
        }
      }

      return {
        area:
          'GENERAL',

        course:
          null,
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

Turn this transcript into polished, highly understandable notes.

MODE:
${mode}

Remove filler and repetition.
Do not invent information.
Organize by topic.

SCHOOL:
Include concepts, definitions, formulas, examples, professor emphasis, likely testable material, common mistakes, questions and key takeaways.

MEETING:
Include executive summary, discussion, decisions, action items, owners, deadlines, risks, open questions and follow-ups.

SALES:
Include executive summary, customer situation, pain points, technical environment, buying signals, opportunities, competitors, objections, budget, timeline, stakeholders, next steps and follow-up questions.

GENERAL:
Organize the important ideas clearly.

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

Also explain any important calculations or numerical implications discussed during the session.

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
                role:
                  'user',

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
            .slice(
              0,
              10,
            )

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
      } catch (
        error
      ) {
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
      if (
        noteTaking
      ) {
        return
      }

      noteTaking =
        true

      noteTranscript =
        []

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
      if (
        !noteTaking
      ) {
        return
      }

      noteTaking =
        false

      g2Socket.send(
        JSON.stringify({
          type:
            'notes_processing',
        }),
      )

      await generateNotes()

      noteTranscript =
        []

      noteStartedAt =
        null
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
            450,

          system: `
You are answering a direct smart-glasses question.

${modePrompt()}

Use the conversation context when relevant.

If the question involves numbers, calculate the answer carefully.

Maximum 65 words.

If the user asks for options, give up to 3.

Be direct.
`,

          messages: [
            {
              role:
                'user',

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

      if (
        question
      ) {
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

          if (
            !transcript
          ) {
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
            noteTaking
          ) {
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
        } catch (
          error
        ) {
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
                JSON.parse(
                  text,
                ),
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
          noteTranscript.length >
            0
        ) {
          noteTaking =
            false

          generateNotes()
            .catch(
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
      `G2 JARVIS v6 running on port ${PORT}`,
    )
  },
)