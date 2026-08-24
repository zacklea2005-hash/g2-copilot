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

// Cache Drive folder IDs while this Railway container is alive.
const driveFolderCache = new Map()

// ==================================================
// LOCAL FALLBACK STORAGE
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
// ACCOUNT MEMORY
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
          accounts:
            persistentMemory.accounts,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error('Memory save error:', error)
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
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')

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

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ==================================================
// HTTP
// ==================================================

app.get('/', (req, res) => {
  res.send(
    'G2 Copilot + Google Drive Notes running',
  )
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    googleClient:
      Boolean(process.env.GOOGLE_CLIENT_ID),
    googleToken:
      Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    version: '4.0',
  })
})

// ==================================================
// GOOGLE AUTH
// ==================================================

app.get('/google/auth', (req, res) => {
  const client = createGoogleOAuthClient()

  const authUrl =
    client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',

      // drive.file lets us create our notes.
      // metadata.readonly lets us FIND your
      // pre-existing G2 Copilot folders.
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
        String(req.query.code || '')

      if (!code) {
        return res
          .status(400)
          .send(
            'Missing Google authorization code.',
          )
      }

      const client =
        createGoogleOAuthClient()

      const { tokens } =
        await client.getToken(code)

      console.log(
        '\n==============================',
      )

      console.log('GOOGLE OAUTH SUCCESS')

      if (tokens.refresh_token) {
        console.log(
          'GOOGLE_REFRESH_TOKEN:',
          tokens.refresh_token,
        )

        console.log(
          'Replace GOOGLE_REFRESH_TOKEN in Railway with this new token.',
        )
      } else {
        console.log(
          'NO NEW REFRESH TOKEN RETURNED',
        )
      }

      console.log(
        '==============================\n',
      )

      res.send(`
        <h1>G2 Copilot</h1>
        <h2>Google Drive connected successfully.</h2>
        <p>Go to Railway logs and copy the new GOOGLE_REFRESH_TOKEN.</p>
      `)
    } catch (error) {
      console.error(
        'Google callback error:',
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
// GOOGLE DRIVE FOLDER HELPERS
// ==================================================

async function findFolder(
  drive,
  name,
  parentId = null,
) {
  const cacheKey =
    `${parentId || 'ROOT'}::${name}`

  if (driveFolderCache.has(cacheKey)) {
    return driveFolderCache.get(cacheKey)
  }

  const escapedName =
    escapeDriveQuery(name)

  const queryParts = [
    `name = '${escapedName}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`,
  ]

  if (parentId) {
    queryParts.push(
      `'${parentId}' in parents`,
    )
  } else {
    queryParts.push(
      `'root' in parents`,
    )
  }

  const result =
    await drive.files.list({
      q: queryParts.join(' and '),
      fields: 'files(id,name,parents)',
      pageSize: 20,
    })

  const folder =
    result.data.files?.[0]

  if (!folder?.id) {
    throw new Error(
      `Google Drive folder not found: ${name}`,
    )
  }

  driveFolderCache.set(
    cacheKey,
    folder.id,
  )

  return folder.id
}

async function getDriveFolderPath(
  route,
) {
  const drive =
    createDriveClient()

  const rootId =
    await findFolder(
      drive,
      'G2 Copilot',
    )

  if (route.area === 'GENERAL') {
    const generalId =
      await findFolder(
        drive,
        'General',
        rootId,
      )

    return {
      drive,
      folderId: generalId,
      path: 'G2 Copilot / General',
    }
  }

  if (route.area === 'WORK') {
    const workId =
      await findFolder(
        drive,
        'Work',
        rootId,
      )

    return {
      drive,
      folderId: workId,
      path: 'G2 Copilot / Work',
    }
  }

  const schoolId =
    await findFolder(
      drive,
      'School',
      rootId,
    )

  if (!route.course) {
    return {
      drive,
      folderId: schoolId,
      path: 'G2 Copilot / School',
    }
  }

  const courseId =
    await findFolder(
      drive,
      route.course,
      schoolId,
    )

  return {
    drive,
    folderId: courseId,
    path:
      `G2 Copilot / School / ${route.course}`,
  }
}

// ==================================================
// CREATE GOOGLE DOC
// ==================================================

async function createGoogleDoc({
  title,
  html,
  folderId,
}) {
  const drive =
    createDriveClient()

  const result =
    await drive.files.create({
      requestBody: {
        name: title,

        // Tell Drive to convert the uploaded HTML
        // into a native Google Doc.
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
// ROUTE SCHOOL NOTES
// ==================================================

async function classifySchoolCourse(
  transcript,
) {
  const response =
    await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 160,

      system: `
Route this university lecture transcript to exactly one of these course folders:

STAT 340
MATH 340
LIS 462
COMP SCI 320
UNSURE

Use the subject matter and any course name/number spoken.

Return ONLY valid JSON:

{
  "course": "STAT 340",
  "confidence": 9
}

If you genuinely cannot tell:

{
  "course": "UNSURE",
  "confidence": 0
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

  const course =
    String(
      parsed?.course || '',
    ).trim()

  if (
    allowed.includes(course) &&
    Number(parsed?.confidence || 0) >= 6
  ) {
    return course
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

  console.log('NEW G2 SESSION')

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

  let manualAskActive = false
  let manualAskBuffer = []
  let manualAskTimer = null

  // ==================================================
  // NOTES STATE
  // ==================================================

  let noteTaking = false
  let noteTranscript = []
  let noteStartedAt = null

  const CARD_COOLDOWN_MS = 12000
  const MIN_RELEVANCE = 7
  const MAX_CONVERSATION_ITEMS = 50

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
  // NOTE GENERATION
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

    console.log(
      'Generating notes from',
      noteTranscript.length,
      'segments',
    )

    try {
      // ----------------------------------------------
      // 1. Determine folder
      // ----------------------------------------------

      const route =
        await determineNoteRoute(
          transcript,
        )

      console.log(
        'NOTE ROUTE:',
        route,
      )

      // ----------------------------------------------
      // 2. Generate polished AI notes
      // ----------------------------------------------

      const response =
        await anthropic.messages.create({
          model: 'claude-sonnet-5',

          max_tokens: 5000,

          system: `
You are an expert professional AI note taker.

Turn the transcript into polished notes that are substantially more useful than a raw transcript.

CURRENT MODE:
${mode}

GENERAL RULES:

- Remove filler, false starts and repetition.
- Preserve important details.
- Organize by topic, not transcript order.
- Use clear headings and bullet points.
- Explain jargon when helpful.
- Never invent facts, dates, owners, statements or formulas.
- If something is uncertain, explicitly label it unclear.
- Do not include the entire raw transcript unless it materially improves the notes.

==================================================
SCHOOL MODE
==================================================

Create excellent university study notes.

Include when relevant:

- Overview
- Main concepts
- Definitions
- Formulas / equations
- What each variable means
- Step-by-step explanations
- Examples from the lecture
- Professor emphasis
- Likely testable material
- Common mistakes
- Questions / confusing points
- Key takeaways

==================================================
MEETING MODE
==================================================

Include when relevant:

- Executive summary
- Main discussion
- Decisions
- Action items
- Owners
- Deadlines
- Risks / blockers
- Open questions
- Follow-ups
- Key takeaways

Never invent an owner or deadline.

==================================================
SALES MODE
==================================================

Include when relevant:

- Executive summary
- Customer situation
- Business problems
- Technical environment
- Pain points
- Buying signals
- Opportunities
- Budget
- Timeline
- Decision makers
- Current vendors
- Competitors
- Objections
- Risks
- Action items
- Next best actions
- Follow-up questions

==================================================
GENERAL MODE
==================================================

Create clean, useful notes organized around the important ideas discussed.

==================================================
MANDATORY ENDING FOR EVERY NOTE
==================================================

EVERY NOTE MUST END WITH:

AI SUMMARY & EXPLANATION

This section is mandatory regardless of mode.

It should contain:

1. Plain-English Summary
Explain the entire session simply and concisely.

2. What This Really Means
Explain the key ideas in more understandable language.

3. Most Important Things to Remember
Give 3-8 high-value takeaways.

4. Connections
Explain useful relationships between ideas discussed.

For SCHOOL mode also include:

5. How to Study This
Give concise advice for understanding or reviewing the material.

For SALES or MEETING mode also include:

5. What I Would Do Next
Give practical next actions based only on the conversation.

==================================================

Return ONLY valid JSON:

{
  "title": "Short descriptive title",
  "summary": "2-4 sentence summary",
  "html": "<h1>...</h1>..."
}

The HTML will be converted directly into a Google Doc.

Use clean HTML:
<h1>
<h2>
<h3>
<p>
<ul>
<ol>
<li>
<strong>
<em>
<table>
<tr>
<th>
<td>

Do NOT include:
<html>
<head>
<body>
script
style

Do not put JSON inside markdown fences.
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

      const parsed =
        parseClaudeJson(
          extractText(response),
        )

      if (
        !parsed?.html ||
        !parsed?.title
      ) {
        throw new Error(
          'Claude did not return valid note HTML.',
        )
      }

      const title =
        String(
          parsed.title,
        ).trim()

      const summary =
        String(
          parsed.summary || '',
        ).trim()

      const datePrefix =
        new Date()
          .toISOString()
          .slice(0, 10)

      const documentTitle =
        `${datePrefix} — ${title}`

      // ----------------------------------------------
      // 3. Find exact Google Drive folder
      // ----------------------------------------------

      const destination =
        await getDriveFolderPath(
          route,
        )

      console.log(
        'GOOGLE DRIVE DESTINATION:',
        destination.path,
      )

      // ----------------------------------------------
      // 4. Add document metadata heading
      // ----------------------------------------------

      const metadataHtml = `
        <p>
          <strong>Mode:</strong> ${htmlEscape(mode)}
          <br>
          <strong>Date:</strong> ${htmlEscape(datePrefix)}
          ${
            route.course
              ? `<br><strong>Course:</strong> ${htmlEscape(route.course)}`
              : ''
          }
        </p>
        <hr>
      `

      const completeHtml =
        metadataHtml +
        String(parsed.html)

      // ----------------------------------------------
      // 5. Create native Google Doc
      // ----------------------------------------------

      const googleDoc =
        await createGoogleDoc({
          title: documentTitle,
          html: completeHtml,
          folderId:
            destination.folderId,
        })

      console.log(
        'GOOGLE DOC SAVED:',
        googleDoc.name,
      )

      console.log(
        'GOOGLE DOC ID:',
        googleDoc.id,
      )

      console.log(
        'GOOGLE DOC URL:',
        googleDoc.webViewLink,
      )

      // ----------------------------------------------
      // 6. Local backup
      // ----------------------------------------------

      try {
        const localFile =
          `${Date.now()}-${safeFilename(title)}.html`

        fs.writeFileSync(
          path.join(
            NOTES_DIR,
            localFile,
          ),
          completeHtml,
          'utf8',
        )
      } catch (error) {
        console.log(
          'Local backup failed:',
          error.message,
        )
      }

      // ----------------------------------------------
      // 7. Tell G2
      // ----------------------------------------------

      if (
        g2Socket.readyState ===
        WebSocket.OPEN
      ) {
        g2Socket.send(
          JSON.stringify({
            type: 'notes_saved',
            title,
            summary,
            folder:
              destination.path,
            url:
              googleDoc.webViewLink ||
              '',
          }),
        )
      }
    } catch (error) {
      console.error(
        'NOTE GENERATION/SAVE ERROR:',
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
              'Could not save notes to Google Drive.',
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
          type: 'notes_started',
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
          type: 'notes_processing',
        }),
      )
    }

    await generateNotes()

    noteTranscript = []
    noteStartedAt = null
  }

  // ==================================================
  // COMPANY DETECTION
  // ==================================================

  async function detectCompany(
    context,
  ) {
    const response =
      await anthropic.messages.create({
        model: 'claude-sonnet-5',

        max_tokens: 180,

        system: `
Identify the company or organization most relevant to the CURRENT conversation.

Return ONLY valid JSON.

No company:

{
  "company": "",
  "confidence": 0
}

Company:

{
  "company": "Company Name",
  "confidence": 9
}

No markdown.
`,

        messages: [
          {
            role: 'user',
            content: context,
          },
        ],
      })

    const parsed =
      parseClaudeJson(
        extractText(response),
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
          parsed.company || '',
        ).trim(),

      confidence:
        Number(
          parsed.confidence || 0,
        ),
    }
  }

  // ==================================================
  // ACCOUNT RESEARCH
  // ==================================================

  function accountCacheFresh(
    account,
  ) {
    if (!account?.researchedAt) {
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
          searchDepth: 'basic',
          maxResults: 5,
          includeAnswer: true,
        },
      )

    const resultText =
      (result.results || [])
        .slice(0, 5)
        .map(
          (item, index) =>
            [
              `SOURCE ${index + 1}`,
              `Title: ${item.title || ''}`,
              `Content: ${item.content || ''}`,
            ].join('\n'),
        )
        .join('\n\n')

    const research = `
ACCOUNT:
${company}

SUMMARY:
${result.answer || 'None'}

SOURCES:
${resultText}
`

    persistentMemory.accounts[
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
      persistentMemory.accounts[
        key
      ]

    if (
      cached &&
      accountCacheFresh(cached)
    ) {
      return cached.research
    }

    try {
      return await researchAccount(
        company,
      )
    } catch {
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
    if (mode === 'GENERAL') {
      return `
GENERAL MODE:
Surface useful facts, context, explanations, corrections and helpful responses.
`
    }

    if (mode === 'MEETING') {
      return `
MEETING MODE:
Prioritize decisions, commitments, risks, unresolved questions, owners and next steps.
`
    }

    if (mode === 'SCHOOL') {
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
                  ).join(' | ')
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
        model: 'claude-sonnet-5',

        max_tokens: 450,

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
      extractText(response),
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
          conversation.join('\n')

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
              'NO_INSIGHT' ||
            relevance <
              MIN_RELEVANCE
          ) {
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

          let outgoingCard = null

          if (
            type === 'QUESTIONS'
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
              questions.length >= 2
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
            type === 'SAY_THIS' ||
            type === 'KNOW_THIS'
          ) {
            const body =
              String(
                card.body || '',
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
                type: 'card',
                card:
                  outgoingCard,
              }),
            )

            recentCards.push(
              outgoingCard,
            )

            if (
              recentCards.length > 14
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
              outgoingCard.type,
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
        model: 'claude-sonnet-5',

        max_tokens: 350,

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
      extractText(response)

    if (
      answer &&
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

        // Notes recording continues independently
        // from JARVIS/manual ask.
        if (noteTaking) {
          noteTranscript.push(
            transcript,
          )

          console.log(
            'NOTE CAPTURE:',
            transcript,
          )
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
          'Deepgram error:',
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
      if (Buffer.isBuffer(data)) {
        const maybeText =
          data.toString('utf8')

        if (
          maybeText.startsWith('{')
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

      // If you exit while note-taking is active,
      // save whatever has already been captured.
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
      `G2 Copilot + Drive Notes running on port ${PORT}`,
    )
  },
)