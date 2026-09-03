import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const bridge =
  await waitForEvenAppBridge()

const SERVER_URL =
  'wss://g2-copilot-production.up.railway.app/audio'

// ==================================================
// RECONNECT-SAFE SESSION ID
// Same ID survives WebSocket reconnects
// during this app launch.
// ==================================================

const CLIENT_SESSION_ID =
  `g2_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`

// ==================================================
// TYPES
// ==================================================

type Mode =
  | 'SALES'
  | 'GENERAL'
  | 'MEETING'
  | 'SCHOOL'

type Card = {
  type:
    | 'SAY_THIS'
    | 'QUESTIONS'
    | 'KNOW_THIS'

  relevance: number
  urgency?: number
  novelty?: number

  body?: string
  questions?: string[]
}

type SessionContext = {
  raw?: string
  summary?: string
  company?: string
  course?: string
  topic?: string
}

// ==================================================
// OPTIONS
// ==================================================

const modes: Mode[] = [
  'SALES',
  'GENERAL',
  'MEETING',
  'SCHOOL',
]

const courseOptions = [
  'STAT 340',
  'MATH 340',
  'LIS 462',
  'COMP SCI 320',
  'NO CLASS',
]

const contextOptions = [
  'ADD CONTEXT',
  'NO CONTEXT',
]

// ==================================================
// STATE
// ==================================================

let mode: Mode =
  'SALES'

let modeIndex = 0
let courseIndex = 0
let contextOptionIndex = 0

let selectingMode = true
let selectingCourse = false

let choosingContext = false
let speakingContext = false

let manualAsk = false

let notesActive = false
let notesStarting = false
let notesStopping = false
let notesProcessing = false

let currentContext:
  | SessionContext
  | null = null

const cards: Card[] =
  []

let cardIndex = -1

let socket:
  | WebSocket
  | null = null

let micStarted = false

let sessionAttached = false
let hasAttachedOnce = false

let intentionalExit = false

let reconnectTimer:
  | ReturnType<typeof setTimeout>
  | null = null

let reconnectAttempts = 0

let cardTimer:
  | ReturnType<typeof setTimeout>
  | null = null

let statusTimer:
  | ReturnType<typeof setTimeout>
  | null = null

// ==================================================
// DISPLAY
// ==================================================

const mainText =
  new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,

    width: 576,
    height: 288,

    borderWidth: 0,
    borderColor: 5,

    paddingLength: 8,

    containerID: 1,
    containerName: 'main',

    content:
      'G2 COPILOT\n\nStarting…',

    isEventCapture: 1,
  })

await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,

    textObject: [
      mainText,
    ],
  }),
)

function updateHud(
  content: string,
) {
  bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,

      containerName:
        'main',

      content,
    }),
  )
}

// ==================================================
// HELPERS
// ==================================================

function clearCardTimer() {
  if (cardTimer) {
    clearTimeout(
      cardTimer,
    )

    cardTimer = null
  }
}

function clearStatusTimer() {
  if (statusTimer) {
    clearTimeout(
      statusTimer,
    )

    statusTimer = null
  }
}

function padLine(
  left: string,
  right: string,
  width = 31,
) {
  const spaces =
    Math.max(
      2,

      width -
        left.length -
        right.length,
    )

  return (
    left +
    ' '.repeat(
      spaces,
    ) +
    right
  )
}

function divider() {
  return (
    '────────────────────────────'
  )
}

function liveStatus() {
  if (notesProcessing) {
    return '◌ SAVE'
  }

  if (notesStopping) {
    return '◌ STOP'
  }

  if (notesStarting) {
    return '◌ START'
  }

  if (notesActive) {
    return '● REC'
  }

  return '● LIVE'
}

function primaryLabel() {
  if (
    currentContext?.course
  ) {
    return (
      currentContext.course
    )
  }

  if (
    currentContext?.company
  ) {
    return (
      currentContext.company
    )
  }

  return mode
}

function secondaryLabel() {
  if (
    currentContext?.topic
  ) {
    return (
      currentContext.topic
    )
  }

  if (
    mode === 'SCHOOL' &&
    currentContext?.course
  ) {
    return 'Detecting topic…'
  }

  if (
    currentContext?.summary &&
    currentContext.summary !==
      `${currentContext.course} class`
  ) {
    return (
      currentContext.summary
    )
  }

  return 'Listening…'
}

// ==================================================
// MODE MENU
// ==================================================

function showModeMenu() {
  clearCardTimer()
  clearStatusTimer()

  selectingMode = true
  selectingCourse = false

  choosingContext = false
  speakingContext = false

  updateHud(
    'G2 COPILOT\n\n' +
      'CHOOSE MODE\n\n' +
      `      › ${modes[modeIndex]}\n` +
      `        ${modeIndex + 1} / ${modes.length}\n\n` +
      divider() +
      '\n↑ ↓ CHOOSE        TAP SELECT',
  )
}

function changeMode(
  direction: number,
) {
  modeIndex +=
    direction

  if (modeIndex < 0) {
    modeIndex =
      modes.length - 1
  }

  if (
    modeIndex >=
    modes.length
  ) {
    modeIndex = 0
  }

  showModeMenu()
}

// ==================================================
// SCHOOL CLASS MENU
// ==================================================

function showCourseMenu() {
  clearCardTimer()
  clearStatusTimer()

  selectingMode = false
  selectingCourse = true

  choosingContext = false
  speakingContext = false

  updateHud(
    'SCHOOL\n\n' +
      'SELECT CLASS\n\n' +
      `      › ${courseOptions[courseIndex]}\n` +
      `        ${courseIndex + 1} / ${courseOptions.length}\n\n` +
      divider() +
      '\n↑ ↓ CHOOSE        TAP SELECT',
  )
}

function changeCourse(
  direction: number,
) {
  courseIndex +=
    direction

  if (
    courseIndex < 0
  ) {
    courseIndex =
      courseOptions.length -
      1
  }

  if (
    courseIndex >=
    courseOptions.length
  ) {
    courseIndex = 0
  }

  showCourseMenu()
}

function selectCourse() {
  const selected =
    courseOptions[
      courseIndex
    ]

  selectingCourse =
    false

  if (
    selected ===
    'NO CLASS'
  ) {
    currentContext =
      null

    sendControl({
      type:
        'context_skip',
    })

    listeningScreen()

    return
  }

  currentContext = {
    summary:
      `${selected} class`,

    course:
      selected,

    company: '',
    topic: '',
  }

  updateHud(
    padLine(
      selected,
      '● LIVE',
    ) +
      '\n\n' +
      '        Class ready\n\n' +
      '        Listening…',
  )

  sendControl({
    type:
      'set_context',

    context: {
      summary:
        `${selected} class`,

      course:
        selected,

      company: '',
      topic: '',
    },
  })
}

// ==================================================
// SALES / MEETING CONTEXT
// ==================================================

function showContextMenu() {
  clearCardTimer()
  clearStatusTimer()

  selectingMode = false
  selectingCourse = false

  choosingContext = true
  speakingContext = false

  updateHud(
    `${mode}\n\n` +
      'PREPARE SESSION\n\n' +
      `      › ${contextOptions[contextOptionIndex]}\n` +
      `        ${contextOptionIndex + 1} / ${contextOptions.length}\n\n` +
      divider() +
      '\n↑ ↓ CHOOSE        TAP SELECT',
  )
}

function changeContextOption(
  direction: number,
) {
  contextOptionIndex +=
    direction

  if (
    contextOptionIndex < 0
  ) {
    contextOptionIndex =
      contextOptions.length -
      1
  }

  if (
    contextOptionIndex >=
    contextOptions.length
  ) {
    contextOptionIndex = 0
  }

  showContextMenu()
}

function selectContextOption() {
  const selected =
    contextOptions[
      contextOptionIndex
    ]

  if (
    selected ===
    'NO CONTEXT'
  ) {
    skipContext()

    return
  }

  startContextCapture()
}

function startContextCapture() {
  choosingContext = false
  speakingContext = true

  sendControl({
    type:
      'context_start',
  })

  updateHud(
    padLine(
      mode,
      '◌ LISTEN',
    ) +
      '\n\n' +
      '       Add context\n\n' +
      '      Speak naturally\n\n' +
      divider() +
      '\n          TAP CANCEL',
  )
}

function cancelContextCapture() {
  speakingContext =
    false

  choosingContext =
    false

  sendControl({
    type:
      'context_skip',
  })

  listeningScreen()
}

function skipContext() {
  choosingContext =
    false

  speakingContext =
    false

  currentContext =
    null

  sendControl({
    type:
      'context_skip',
  })

  listeningScreen()
}

// ==================================================
// MODE ROUTING
// ==================================================

function enterSelectedMode() {
  cardIndex = -1

  if (
    mode === 'SCHOOL'
  ) {
    showCourseMenu()

    return
  }

  if (
    mode === 'GENERAL'
  ) {
    currentContext =
      null

    sendControl({
      type:
        'context_skip',
    })

    listeningScreen()

    return
  }

  contextOptionIndex =
    0

  showContextMenu()
}

// ==================================================
// RESTING HUD
// ==================================================

function listeningScreen() {
  clearCardTimer()
  clearStatusTimer()

  selectingMode = false
  selectingCourse = false

  choosingContext = false
  speakingContext = false

  cardIndex = -1

  const footerRight =
    notesActive
      ? '↓ STOP'
      : '↓ NOTES'

  let centerStatus =
    '        Listening…'

  if (notesStarting) {
    centerStatus =
      '      Starting notes…'
  } else if (
    notesStopping
  ) {
    centerStatus =
      '      Stopping notes…'
  } else if (
    notesProcessing
  ) {
    centerStatus =
      '      Building notes…'
  } else if (
    notesActive
  ) {
    centerStatus =
      '        Taking notes'
  }

  updateHud(
    padLine(
      primaryLabel(),
      liveStatus(),
    ) +
      '\n\n' +
      `        ${secondaryLabel()}\n\n` +
      centerStatus +
      '\n\n' +
      divider() +
      '\n' +
      padLine(
        '↑ HISTORY  TAP ASK',
        footerRight,
      ),
  )
}

// ==================================================
// CARDS
// ==================================================

function cardContainsMath(
  card: Card,
) {
  const text =
    String(
      card.body || '',
    )

  return (
    /[$€£]/.test(text) ||
    /\b\d+(?:\.\d+)?\s*%/.test(
      text,
    ) ||
    /[×÷=]/.test(
      text,
    ) ||
    /\b(?:annual|monthly|discount|savings|spend|price)\b/i.test(
      text,
    )
  )
}

function cardTitle(
  card: Card,
) {
  if (
    card.type ===
    'QUESTIONS'
  ) {
    return '? ASK'
  }

  if (
    card.type ===
    'SAY_THIS'
  ) {
    return '→ SAY'
  }

  if (
    Number(
      card.urgency ||
        0,
    ) >= 9
  ) {
    return '! IMPORTANT'
  }

  if (
    cardContainsMath(
      card,
    )
  ) {
    return '∑ QUICK MATH'
  }

  return '◆ INSIGHT'
}

function cardCounter() {
  if (
    cardIndex < 0 ||
    cards.length === 0
  ) {
    return ''
  }

  return (
    `${cardIndex + 1} / ${cards.length}`
  )
}

function renderCard(
  card: Card,
) {
  let body = ''

  if (
    card.type ===
    'QUESTIONS'
  ) {
    body =
      card.questions?.[0] ||
      ''
  } else if (
    card.type ===
    'SAY_THIS'
  ) {
    const raw =
      String(
        card.body || '',
      ).trim()

    body =
      raw.startsWith(
        '"',
      ) ||
      raw.startsWith(
        '“',
      )
        ? raw
        : `“${raw}”`
  } else {
    body =
      card.body || ''
  }

  return (
    padLine(
      cardTitle(card),
      cardCounter(),
    ) +
      '\n\n' +
      body +
      '\n\n' +
      divider() +
      '\n↑ PREV     TAP CLOSE     ↓ NEXT'
  )
}

function expandCard(
  card: Card,
): Card[] {
  if (
    card.type !==
      'QUESTIONS' ||
    !Array.isArray(
      card.questions,
    ) ||
    card.questions.length <=
      1
  ) {
    return [card]
  }

  return card.questions
    .filter(Boolean)
    .map(
      question => ({
        ...card,

        questions: [
          question,
        ],
      }),
    )
}

function trimHistory() {
  const MAX_CARDS =
    24

  if (
    cards.length <=
    MAX_CARDS
  ) {
    return 0
  }

  const removeCount =
    cards.length -
    MAX_CARDS

  cards.splice(
    0,
    removeCount,
  )

  return removeCount
}

function scheduleAmbientDismiss(
  card: Card,
) {
  clearCardTimer()

  const relevance =
    Number(
      card.relevance ||
        0,
    )

  const urgency =
    Number(
      card.urgency ||
        0,
    )

  if (
    relevance >= 9 ||
    urgency >= 9
  ) {
    return
  }

  cardTimer =
    setTimeout(
      () => {
        cardTimer =
          null

        if (
          cardIndex >= 0 &&
          !manualAsk &&
          !speakingContext
        ) {
          cardIndex =
            -1

          listeningScreen()
        }
      },
      8000,
    )
}

function showCurrentCard(
  interruption = false,
) {
  clearCardTimer()

  if (
    cardIndex < 0 ||
    cards.length === 0
  ) {
    listeningScreen()

    return
  }

  if (
    cardIndex >=
    cards.length
  ) {
    cardIndex =
      cards.length - 1
  }

  updateHud(
    renderCard(
      cards[
        cardIndex
      ],
    ),
  )

  if (interruption) {
    scheduleAmbientDismiss(
      cards[
        cardIndex
      ],
    )
  }
}

function addCard(
  incoming: Card,
) {
  const expanded =
    expandCard(
      incoming,
    )

  if (
    expanded.length ===
    0
  ) {
    return
  }

  const wasListening =
    cardIndex === -1

  const oldLength =
    cards.length

  cards.push(
    ...expanded,
  )

  const removed =
    trimHistory()

  if (
    cardIndex >= 0
  ) {
    cardIndex =
      Math.max(
        0,

        cardIndex -
          removed,
      )
  }

  if (
    wasListening &&
    !manualAsk &&
    !speakingContext &&
    !choosingContext &&
    !selectingCourse &&
    !selectingMode
  ) {
    cardIndex =
      Math.max(
        0,

        oldLength -
          removed,
      )

    showCurrentCard(
      true,
    )
  }
}

function addBriefingCards(
  briefing: Card[],
) {
  const expanded =
    briefing.flatMap(
      expandCard,
    )

  if (
    expanded.length ===
    0
  ) {
    listeningScreen()

    return
  }

  const oldLength =
    cards.length

  cards.push(
    ...expanded,
  )

  const removed =
    trimHistory()

  cardIndex =
    Math.max(
      0,

      oldLength -
        removed,
    )

  showCurrentCard(
    true,
  )
}

function previousCard() {
  clearCardTimer()

  if (
    cards.length ===
    0
  ) {
    listeningScreen()

    return
  }

  if (
    cardIndex === -1
  ) {
    cardIndex =
      cards.length - 1
  } else if (
    cardIndex > 0
  ) {
    cardIndex -=
      1
  }

  showCurrentCard(
    false,
  )
}

function nextCard() {
  clearCardTimer()

  if (
    cards.length ===
    0
  ) {
    listeningScreen()

    return
  }

  if (
    cardIndex === -1
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard(
      false,
    )

    return
  }

  if (
    cardIndex <
    cards.length - 1
  ) {
    cardIndex +=
      1

    showCurrentCard(
      false,
    )

    return
  }

  cardIndex = -1

  listeningScreen()
}

// ==================================================
// RESET UI
// ==================================================

function clearSessionUi() {
  clearCardTimer()
  clearStatusTimer()

  cards.splice(
    0,
    cards.length,
  )

  cardIndex = -1

  currentContext =
    null

  manualAsk =
    false

  notesActive =
    false

  notesStarting =
    false

  notesStopping =
    false

  notesProcessing =
    false
}

// ==================================================
// NOTES — SERVER CONFIRMED
// ==================================================

function showNotesTransportError(
  text: string,
) {
  updateHud(
    '! NOTES\n\n' +
      text +
      '\n\n' +
      divider() +
      '\n        Reconnecting…',
  )
}

function toggleNotes() {
  clearCardTimer()
  clearStatusTimer()

  if (
    notesStarting ||
    notesStopping ||
    notesProcessing
  ) {
    return
  }

  if (!notesActive) {
    notesStarting =
      true

    updateHud(
      padLine(
        primaryLabel(),
        '◌ START',
      ) +
        '\n\n' +
        '      Starting notes\n\n' +
        '    Waiting for server…',
    )

    const sent =
      sendControl({
        type:
          'notes_start',
      })

    if (!sent) {
      notesStarting =
        false

      showNotesTransportError(
        'Could not start recording.',
      )
    }

    return
  }

  notesStopping =
    true

  updateHud(
    padLine(
      primaryLabel(),
      '◌ STOP',
    ) +
      '\n\n' +
      '      Ending notes\n\n' +
      '    Waiting for server…',
  )

  const sent =
    sendControl({
      type:
        'notes_stop',
    })

  if (!sent) {
    notesStopping =
      false

    // Recording remains active on backend
    // until confirmed otherwise.
    notesActive =
      true

    showNotesTransportError(
      'Recording preserved.',
    )
  }
}

// ==================================================
// MANUAL ASK
// ==================================================

function startManualAsk() {
  clearCardTimer()

  manualAsk =
    true

  cardIndex =
    -1

  sendControl({
    type:
      'manual_ask_start',
  })

  updateHud(
    padLine(
      'ASK JARVIS',
      '◌ LISTEN',
    ) +
      '\n\n' +
      '       Ask anything\n\n' +
      '        Listening…\n\n' +
      divider() +
      '\n          TAP CANCEL',
  )
}

function cancelManualAsk() {
  manualAsk =
    false

  sendControl({
    type:
      'manual_ask_cancel',
  })

  listeningScreen()
}

// ==================================================
// SOCKET
// ==================================================

function socketOpen() {
  return (
    socket !== null &&
    socket.readyState ===
      WebSocket.OPEN
  )
}

function sendControl(
  payload: object,
) {
  if (
    !socketOpen()
  ) {
    return false
  }

  socket?.send(
    JSON.stringify(
      payload,
    ),
  )

  return true
}

async function ensureMicrophone() {
  if (micStarted) {
    return true
  }

  const started =
    await bridge.audioControl(
      true,
    )

  if (started) {
    micStarted =
      true
  }

  return started
}

// ==================================================
// RECONNECT
// ==================================================

function scheduleReconnect() {
  if (
    intentionalExit ||
    reconnectTimer
  ) {
    return
  }

  sessionAttached =
    false

  reconnectAttempts +=
    1

  const delay =
    Math.min(
      reconnectAttempts *
        2000,

      10000,
    )

  updateHud(
    padLine(
      primaryLabel(),
      '◌',
    ) +
      '\n\n' +
      '     Connection lost\n\n' +
      (
        notesActive
          ? '     Notes preserved'
          : '      Reconnecting…'
      ),
  )

  reconnectTimer =
    setTimeout(
      () => {
        reconnectTimer =
          null

        connectSocket()
      },
      delay,
    )
}

// ==================================================
// CONNECTION
// ==================================================

function connectSocket() {
  sessionAttached =
    false

  socket =
    new WebSocket(
      SERVER_URL,
    )

  socket.binaryType =
    'arraybuffer'

  socket.onopen =
    async () => {
      reconnectAttempts =
        0

      // IMPORTANT:
      // attach session before trusting
      // this socket for audio/control.
      sendControl({
        type:
          'hello',

        sessionId:
          CLIENT_SESSION_ID,
      })

      const micOkay =
        await ensureMicrophone()

      if (!micOkay) {
        updateHud(
          '! MICROPHONE\n\n' +
            'Audio could not start.',
        )

        return
      }

      updateHud(
        padLine(
          'G2 COPILOT',
          '◌',
        ) +
          '\n\n' +
          '     Restoring session…',
      )
    }

  socket.onmessage =
    event => {
      try {
        const message =
          JSON.parse(
            event.data,
          )

        // ----------------------------------------
        // SESSION ATTACHED
        // ----------------------------------------

        if (
          message.type ===
          'session_attached'
        ) {
          sessionAttached =
            true

          if (
            message.mode
          ) {
            mode =
              message.mode as Mode

            const found =
              modes.indexOf(
                mode,
              )

            if (
              found >= 0
            ) {
              modeIndex =
                found
            }
          }

          if (
            message.context &&
            (
              message.context
                .summary ||
              message.context
                .company ||
              message.context
                .course ||
              message.context
                .topic
            )
          ) {
            currentContext =
              message.context
          } else {
            currentContext =
              null
          }

          notesActive =
            message.notesActive ===
            true

          notesStarting =
            false

          notesStopping =
            false

          notesProcessing =
            false

          const hadAttached =
            hasAttachedOnce

          hasAttachedOnce =
            true

          if (
            hadAttached ||
            message.resumed
          ) {
            listeningScreen()
          } else {
            showModeMenu()
          }

          return
        }

        if (
          message.type ===
          'session_attach_error'
        ) {
          sessionAttached =
            false

          updateHud(
            '! CONNECTION\n\n' +
              String(
                message.text ||
                  'Could not restore session.',
              ),
          )

          return
        }

        // ----------------------------------------
        // CARD
        // ----------------------------------------

        if (
          message.type ===
            'card' &&
          message.card
        ) {
          addCard(
            message.card as Card,
          )

          return
        }

        // ----------------------------------------
        // MODE
        // ----------------------------------------

        if (
          message.type ===
          'mode_changed'
        ) {
          mode =
            message.mode as Mode

          const found =
            modes.indexOf(
              mode,
            )

          if (
            found >= 0
          ) {
            modeIndex =
              found
          }

          return
        }

        // ----------------------------------------
        // CONTEXT
        // ----------------------------------------

        if (
          message.type ===
          'context_ready'
        ) {
          speakingContext =
            false

          choosingContext =
            false

          selectingCourse =
            false

          currentContext =
            message.context ||
            currentContext

          const briefing =
            Array.isArray(
              message.briefing,
            )
              ? message.briefing as Card[]
              : []

          const label =
            currentContext?.course ||
            currentContext?.company ||
            currentContext?.summary ||
            mode

          updateHud(
            padLine(
              label,
              liveStatus(),
            ) +
              '\n\n' +
              (
                mode ===
                'SCHOOL'
                  ? '       Class ready'
                  : '      Context ready'
              ) +
              '\n\n' +
              '        Listening…',
          )

          statusTimer =
            setTimeout(
              () => {
                statusTimer =
                  null

                if (
                  briefing.length >
                  0
                ) {
                  addBriefingCards(
                    briefing,
                  )
                } else {
                  listeningScreen()
                }
              },
              900,
            )

          return
        }

        if (
          message.type ===
          'context_updated'
        ) {
          currentContext =
            message.context ||
            currentContext

          if (
            cardIndex === -1 &&
            !manualAsk &&
            !speakingContext &&
            !choosingContext
          ) {
            listeningScreen()
          }

          return
        }

        if (
          message.type ===
          'context_skipped'
        ) {
          speakingContext =
            false

          choosingContext =
            false

          listeningScreen()

          return
        }

        if (
          message.type ===
          'context_error'
        ) {
          speakingContext =
            false

          updateHud(
            '! CONTEXT\n\n' +
              String(
                message.text ||
                  'Could not load context.',
              ),
          )

          return
        }

        // ----------------------------------------
        // NOTES — CONFIRMED BY SERVER
        // ----------------------------------------

        if (
          message.type ===
          'notes_started'
        ) {
          notesStarting =
            false

          notesStopping =
            false

          notesProcessing =
            false

          notesActive =
            true

          updateHud(
            padLine(
              primaryLabel(),
              '● REC',
            ) +
              '\n\n' +
              (
                message.resumed
                  ? '    Recording restored'
                  : '      Notes started'
              ) +
              '\n\n' +
              '        Taking notes',
          )

          statusTimer =
            setTimeout(
              () => {
                statusTimer =
                  null

                listeningScreen()
              },
              900,
            )

          return
        }

        if (
          message.type ===
          'notes_processing'
        ) {
          notesStarting =
            false

          notesStopping =
            false

          notesActive =
            false

          notesProcessing =
            true

          updateHud(
            padLine(
              primaryLabel(),
              '◌ SAVE',
            ) +
              '\n\n' +
              '      Building notes\n\n' +
              '     AI organizing…',
          )

          return
        }

        if (
          message.type ===
          'notes_saved'
        ) {
          notesStarting =
            false

          notesStopping =
            false

          notesActive =
            false

          notesProcessing =
            false

          updateHud(
            padLine(
              '✓ SAVED',

              currentContext?.course ||
                mode,
            ) +
              '\n\n' +
              String(
                message.title ||
                  'Session Notes',
              ) +
              '\n\n' +
              '       Google Drive',
          )

          statusTimer =
            setTimeout(
              () => {
                statusTimer =
                  null

                listeningScreen()
              },
              2500,
            )

          return
        }

        if (
          message.type ===
          'notes_error'
        ) {
          notesStarting =
            false

          notesStopping =
            false

          notesProcessing =
            false

          updateHud(
            '! NOTES\n\n' +
              String(
                message.text ||
                  'Notes failed.',
              ) +
              '\n\n' +
              divider() +
              '\n          TAP CLOSE',
          )

          return
        }

        // ----------------------------------------
        // MANUAL ASK
        // ----------------------------------------

        if (
          message.type ===
          'manual_answer'
        ) {
          manualAsk =
            false

          updateHud(
            padLine(
              'JARVIS',
              '✓',
            ) +
              '\n\n' +
              String(
                message.text,
              ) +
              '\n\n' +
              divider() +
              '\n          TAP CLOSE',
          )

          return
        }

        // ----------------------------------------
        // RESET
        // ----------------------------------------

        if (
          message.type ===
          'session_reset'
        ) {
          clearSessionUi()

          if (
            message.mode
          ) {
            mode =
              message.mode as Mode

            const found =
              modes.indexOf(
                mode,
              )

            if (
              found >= 0
            ) {
              modeIndex =
                found
            }
          }

          updateHud(
            'NEW SESSION\n\n' +
              `${mode}\n\n` +
              'Ready…',
          )

          statusTimer =
            setTimeout(
              () => {
                statusTimer =
                  null

                enterSelectedMode()
              },
              700,
            )

          return
        }
      } catch (error) {
        console.error(
          'Server message error:',
          error,
        )
      }
    }

  socket.onerror =
    error => {
      console.error(
        'WebSocket error:',
        error,
      )
    }

  socket.onclose =
    () => {
      socket =
        null

      sessionAttached =
        false

      if (
        !intentionalExit
      ) {
        scheduleReconnect()
      }
    }
}

connectSocket()

// ==================================================
// EVENT HELPER
// Keep the tap fallback that works on your G2.
// ==================================================

function eventTypeOf(
  envelope?: {
    eventType?:
      OsEventTypeList
  },
):
  | OsEventTypeList
  | null {
  if (!envelope) {
    return null
  }

  return (
    envelope.eventType ??
    OsEventTypeList.CLICK_EVENT
  )
}

// ==================================================
// EXIT
// ==================================================

function exitCopilot() {
  intentionalExit =
    true

  clearCardTimer()
  clearStatusTimer()

  if (
    reconnectTimer
  ) {
    clearTimeout(
      reconnectTimer,
    )

    reconnectTimer =
      null
  }

  bridge.audioControl(
    false,
  )

  micStarted =
    false

  if (
    socket &&
    (
      socket.readyState ===
        WebSocket.OPEN ||
      socket.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    socket.close()
  }

  bridge.shutDownPageContainer(
    1,
  )
}

// ==================================================
// G2 EVENTS
// ==================================================

const unsubscribe =
  bridge.onEvenHubEvent(
    event => {
      // ------------------------------------------
      // AUDIO
      // Only transmit after server has attached
      // the reconnect-safe session.
      // ------------------------------------------

      if (
        event.audioEvent
          ?.audioPcm &&
        socketOpen() &&
        sessionAttached
      ) {
        socket?.send(
          new Uint8Array(
            event.audioEvent
              .audioPcm,
          ).buffer,
        )
      }

      const sysType =
        eventTypeOf(
          event.sysEvent,
        )

      const textType =
        eventTypeOf(
          event.textEvent,
        )

      // ------------------------------------------
      // DOUBLE TAP = EXIT
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType ===
          OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        exitCopilot()

        return
      }

      // ------------------------------------------
      // SWIPE UP
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.SCROLL_TOP_EVENT ||
        textType ===
          OsEventTypeList.SCROLL_TOP_EVENT
      ) {
        clearStatusTimer()

        if (
          selectingMode
        ) {
          changeMode(-1)

          return
        }

        if (
          selectingCourse
        ) {
          changeCourse(-1)

          return
        }

        if (
          choosingContext
        ) {
          changeContextOption(
            -1,
          )

          return
        }

        if (
          speakingContext ||
          manualAsk
        ) {
          return
        }

        previousCard()

        return
      }

      // ------------------------------------------
      // SWIPE DOWN
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        textType ===
          OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        clearStatusTimer()

        if (
          selectingMode
        ) {
          changeMode(1)

          return
        }

        if (
          selectingCourse
        ) {
          changeCourse(1)

          return
        }

        if (
          choosingContext
        ) {
          changeContextOption(
            1,
          )

          return
        }

        if (
          speakingContext ||
          manualAsk
        ) {
          return
        }

        if (
          cardIndex >= 0
        ) {
          nextCard()

          return
        }

        toggleNotes()

        return
      }

      // ------------------------------------------
      // TAP
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.CLICK_EVENT ||
        textType ===
          OsEventTypeList.CLICK_EVENT
      ) {
        clearCardTimer()
        clearStatusTimer()

        if (
          selectingMode
        ) {
          mode =
            modes[
              modeIndex
            ]

          selectingMode =
            false

          sendControl({
            type:
              'set_mode',

            mode,
          })

          enterSelectedMode()

          return
        }

        if (
          selectingCourse
        ) {
          selectCourse()

          return
        }

        if (
          choosingContext
        ) {
          selectContextOption()

          return
        }

        if (
          speakingContext
        ) {
          cancelContextCapture()

          return
        }

        if (
          manualAsk
        ) {
          cancelManualAsk()

          return
        }

        if (
          cardIndex >= 0
        ) {
          cardIndex =
            -1

          listeningScreen()

          return
        }

        if (
          notesStarting ||
          notesStopping ||
          notesProcessing
        ) {
          return
        }

        startManualAsk()

        return
      }

      // ------------------------------------------
      // SYSTEM EXIT
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.SYSTEM_EXIT_EVENT ||
        sysType ===
          OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        intentionalExit =
          true

        clearCardTimer()
        clearStatusTimer()

        bridge.audioControl(
          false,
        )

        micStarted =
          false

        if (socket) {
          socket.close()
        }

        unsubscribe()
      }
    },
  )