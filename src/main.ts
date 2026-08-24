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
  'OTHER / NO CLASS',
]

// ==================================================
// STATE
// ==================================================

let mode: Mode = 'SALES'
let modeIndex = 0

let courseIndex = 0

let selectingMode = true
let selectingCourse = false

let choosingContext = false
let speakingContext = false

let manualAsk = false

let notesActive = false
let notesProcessing = false

let currentContext:
  | SessionContext
  | null = null

const cards: Card[] = []
let cardIndex = -1

let socket:
  | WebSocket
  | null = null

let micStarted = false

let intentionalExit = false

let reconnectTimer:
  | ReturnType<typeof setTimeout>
  | null = null

let reconnectAttempts = 0

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
      'G2 COPILOT\n\nStarting...',

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
      containerName: 'main',
      content,
    }),
  )
}

// ==================================================
// MODE MENU
// ==================================================

function showModeMenu() {
  selectingMode = true
  selectingCourse = false

  choosingContext = false
  speakingContext = false

  updateHud(
    'SELECT MODE\n\n' +
      `> ${modes[modeIndex]}\n\n` +
      '↑ ↓ change\n' +
      'Tap: select',
  )
}

function changeMode(
  direction: number,
) {
  modeIndex += direction

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
// SCHOOL COURSE MENU
// ==================================================

function showCourseMenu() {
  selectingMode = false
  selectingCourse = true

  choosingContext = false
  speakingContext = false

  updateHud(
    'SELECT CLASS\n\n' +
      `> ${courseOptions[courseIndex]}\n\n` +
      '↑ ↓ change\n' +
      'Tap: select',
  )
}

function changeCourse(
  direction: number,
) {
  courseIndex += direction

  if (courseIndex < 0) {
    courseIndex =
      courseOptions.length - 1
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
    courseOptions[courseIndex]

  selectingCourse = false

  if (
    selected ===
    'OTHER / NO CLASS'
  ) {
    currentContext = null

    sendControl({
      type: 'context_skip',
    })

    listeningScreen()

    return
  }

  currentContext = {
    summary:
      `${selected} class`,

    course: selected,

    company: '',
    topic: '',
  }

  updateHud(
    'CLASS SELECTED\n\n' +
      selected +
      '\n\nPreparing...',
  )

  sendControl({
    type: 'set_context',

    context: {
      summary:
        `${selected} class`,

      course: selected,

      company: '',
      topic: '',
    },
  })
}

// ==================================================
// SALES / MEETING CONTEXT
// ==================================================

function showContextChoice() {
  selectingMode = false
  selectingCourse = false

  choosingContext = true
  speakingContext = false

  updateHud(
    'ADD CONTEXT?\n\n' +
      'Tap: speak context\n' +
      '↓: skip\n\n' +
      'Example:\n' +
      '"ServiceNow AI meeting"',
  )
}

function startContextCapture() {
  choosingContext = false
  speakingContext = true

  sendControl({
    type: 'context_start',
  })

  updateHud(
    'SET CONTEXT\n\n' +
      'Speak now...\n\n' +
      'Tap: cancel',
  )
}

function cancelContextCapture() {
  speakingContext = false
  choosingContext = false

  sendControl({
    type: 'context_skip',
  })

  listeningScreen()
}

function skipContext() {
  choosingContext = false
  speakingContext = false

  currentContext = null

  sendControl({
    type: 'context_skip',
  })

  listeningScreen()
}

// ==================================================
// ROUTE AFTER MODE SELECTION
// ==================================================

function enterSelectedMode() {
  if (mode === 'SCHOOL') {
    showCourseMenu()
    return
  }

  if (mode === 'GENERAL') {
    currentContext = null

    sendControl({
      type: 'context_skip',
    })

    listeningScreen()

    return
  }

  showContextChoice()
}

// ==================================================
// LISTENING SCREEN
// ==================================================

function listeningScreen() {
  selectingMode = false
  selectingCourse = false

  choosingContext = false
  speakingContext = false

  const notes =
    notesActive
      ? 'NOTES: RECORDING'
      : notesProcessing
        ? 'NOTES: SAVING...'
        : 'NOTES: OFF'

  let contextLine = ''

  if (
    currentContext?.course
  ) {
    contextLine =
      currentContext.topic
        ? `${currentContext.course} · ${currentContext.topic}`
        : currentContext.course
  } else if (
    currentContext?.company
  ) {
    contextLine =
      currentContext.company
  } else if (
    currentContext?.topic
  ) {
    contextLine =
      currentContext.topic
  }

  updateHud(
    `${mode} MODE\n` +
      (
        contextLine
          ? `${contextLine}\n`
          : ''
      ) +
      `${notes}\n\n` +
      'Tap: ask me\n' +
      '↓ notes · ↑ cards',
  )
}

// ==================================================
// CARDS
// ==================================================

function renderCard(
  card: Card,
) {
  if (
    card.type ===
    'SAY_THIS'
  ) {
    return (
      'SAY THIS\n\n' +
      (card.body || '') +
      '\n\n↑ previous   ↓ next'
    )
  }

  if (
    card.type ===
    'QUESTIONS'
  ) {
    const lines =
      (
        card.questions || []
      )
        .slice(0, 3)
        .map(
          (
            question,
            index,
          ) =>
            `${index + 1}. ${question}`,
        )
        .join('\n')

    return (
      'QUESTIONS\n\n' +
      lines +
      '\n\n↑ previous   ↓ next'
    )
  }

  return (
    'KNOW THIS\n\n' +
    (card.body || '') +
    '\n\n↑ previous   ↓ next'
  )
}

function showCurrentCard() {
  if (
    cardIndex < 0 ||
    cards.length === 0
  ) {
    cardIndex = -1
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
      cards[cardIndex],
    ),
  )
}

function addCard(
  card: Card,
) {
  const wasListening =
    cardIndex === -1

  cards.push(card)

  if (
    cards.length > 20
  ) {
    cards.shift()

    if (
      cardIndex > 0
    ) {
      cardIndex -= 1
    }
  }

  if (
    wasListening &&
    !manualAsk &&
    !speakingContext &&
    !choosingContext &&
    !selectingCourse
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard()
  }
}

function addBriefingCards(
  briefing: Card[],
) {
  if (
    briefing.length === 0
  ) {
    listeningScreen()
    return
  }

  for (
    const card of briefing
  ) {
    cards.push(card)
  }

  while (
    cards.length > 20
  ) {
    cards.shift()
  }

  cardIndex =
    Math.max(
      0,
      cards.length -
        briefing.length,
    )

  showCurrentCard()
}

function previousCard() {
  if (
    cards.length === 0
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
    cardIndex -= 1
  }

  showCurrentCard()
}

function nextCard() {
  if (
    cards.length === 0
  ) {
    listeningScreen()
    return
  }

  if (
    cardIndex === -1
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard()
    return
  }

  if (
    cardIndex <
    cards.length - 1
  ) {
    cardIndex += 1

    showCurrentCard()
    return
  }

  cardIndex = -1
  listeningScreen()
}

// ==================================================
// CLEAR SESSION UI
// ==================================================

function clearSessionUi() {
  cards.splice(
    0,
    cards.length,
  )

  cardIndex = -1

  currentContext = null

  manualAsk = false

  notesActive = false
  notesProcessing = false
}

// ==================================================
// NOTES
// ==================================================

function toggleNotes() {
  if (notesProcessing) {
    return
  }

  if (!notesActive) {
    notesActive = true

    sendControl({
      type: 'notes_start',
    })

    updateHud(
      'NOTES\n\n' +
        'Recording started...',
    )

    setTimeout(
      listeningScreen,
      700,
    )

    return
  }

  notesActive = false
  notesProcessing = true

  sendControl({
    type: 'notes_stop',
  })

  updateHud(
    'NOTES\n\n' +
      'Generating notes...',
  )
}

// ==================================================
// MANUAL ASK
// ==================================================

function startManualAsk() {
  manualAsk = true
  cardIndex = -1

  sendControl({
    type:
      'manual_ask_start',
  })

  updateHud(
    'ASK ME\n\n' +
      'Speak your question...\n\n' +
      '"new session" resets',
  )
}

function cancelManualAsk() {
  manualAsk = false

  sendControl({
    type:
      'manual_ask_cancel',
  })

  listeningScreen()
}

// ==================================================
// SOCKET HELPERS
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
  if (!socketOpen()) {
    return
  }

  socket?.send(
    JSON.stringify(
      payload,
    ),
  )
}

// ==================================================
// MICROPHONE
// ==================================================

async function ensureMicrophone() {
  if (micStarted) {
    return true
  }

  const started =
    await bridge.audioControl(
      true,
    )

  if (started) {
    micStarted = true
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

  reconnectAttempts += 1

  const delay =
    Math.min(
      reconnectAttempts * 2000,
      10000,
    )

  updateHud(
    'G2 COPILOT\n\n' +
      'Connection lost.\n' +
      'Reconnecting...',
  )

  reconnectTimer =
    setTimeout(
      () => {
        reconnectTimer = null

        connectSocket(true)
      },
      delay,
    )
}

// ==================================================
// SERVER CONNECTION
// ==================================================

function connectSocket(
  reconnecting = false,
) {
  socket =
    new WebSocket(
      SERVER_URL,
    )

  socket.binaryType =
    'arraybuffer'

  socket.onopen =
    async () => {
      console.log(
        'Connected to cloud server',
      )

      reconnectAttempts = 0

      const micOkay =
        await ensureMicrophone()

      if (!micOkay) {
        updateHud(
          'G2 COPILOT\n\n' +
            'Microphone failed.',
        )

        return
      }

      if (reconnecting) {
        sendControl({
          type:
            'restore_session',

          mode,

          context:
            currentContext,
        })

        updateHud(
          'G2 COPILOT\n\n' +
            'Reconnected...',
        )

        return
      }

      showModeMenu()
    }

  socket.onmessage =
    event => {
      try {
        const message =
          JSON.parse(
            event.data,
          )

        // ------------------------------------------
        // JARVIS CARD
        // ------------------------------------------

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

        // ------------------------------------------
        // MODE
        // ------------------------------------------

        if (
          message.type ===
          'mode_changed'
        ) {
          mode =
            message.mode as Mode

          const index =
            modes.indexOf(mode)

          if (index >= 0) {
            modeIndex = index
          }

          return
        }

        // ------------------------------------------
        // CONTEXT READY
        // ------------------------------------------

        if (
          message.type ===
          'context_ready'
        ) {
          speakingContext = false
          choosingContext = false
          selectingCourse = false

          currentContext =
            message.context || null

          const briefing =
            Array.isArray(
              message.briefing,
            )
              ? (
                  message.briefing as Card[]
                )
              : []

          const label =
            currentContext?.course ||
            currentContext?.summary ||
            currentContext?.company ||
            'Context loaded'

          updateHud(
            (
              mode === 'SCHOOL'
                ? 'CLASS READY\n\n'
                : 'CONTEXT READY\n\n'
            ) +
              label +
              '\n\nListening...',
          )

          setTimeout(
            () => {
              addBriefingCards(
                briefing,
              )
            },
            900,
          )

          return
        }

        // ------------------------------------------
        // TOPIC AUTO-DETECTED
        // Do not interrupt the lecture.
        // ------------------------------------------

        if (
          message.type ===
          'context_updated'
        ) {
          currentContext =
            message.context ||
            currentContext

          // Update state silently.
          // We intentionally do NOT
          // replace a card or interrupt notes.

          return
        }

        if (
          message.type ===
          'context_skipped'
        ) {
          speakingContext = false
          choosingContext = false

          listeningScreen()
          return
        }

        if (
          message.type ===
          'context_error'
        ) {
          speakingContext = false

          updateHud(
            'CONTEXT ERROR\n\n' +
              String(
                message.text ||
                  'Could not load.',
              ),
          )

          setTimeout(
            listeningScreen,
            1200,
          )

          return
        }

        // ------------------------------------------
        // SESSION RESET
        // ------------------------------------------

        if (
          message.type ===
          'session_reset'
        ) {
          clearSessionUi()

          if (message.mode) {
            mode =
              message.mode as Mode

            const index =
              modes.indexOf(mode)

            if (index >= 0) {
              modeIndex = index
            }
          }

          updateHud(
            'NEW SESSION\n\n' +
              `${mode} MODE`,
          )

          setTimeout(
            () => {
              enterSelectedMode()
            },
            700,
          )

          return
        }

        // ------------------------------------------
        // SESSION RESTORED
        // ------------------------------------------

        if (
          message.type ===
          'session_restored'
        ) {
          if (message.mode) {
            mode =
              message.mode as Mode
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
          }

          listeningScreen()
          return
        }

        // ------------------------------------------
        // MANUAL ANSWER
        // ------------------------------------------

        if (
          message.type ===
          'manual_answer'
        ) {
          manualAsk = false

          updateHud(
            'ANSWER\n\n' +
              String(
                message.text,
              ) +
              '\n\nTap: back',
          )

          return
        }

        // ------------------------------------------
        // NOTES
        // ------------------------------------------

        if (
          message.type ===
          'notes_started'
        ) {
          notesActive = true
          notesProcessing = false

          listeningScreen()
          return
        }

        if (
          message.type ===
          'notes_processing'
        ) {
          notesActive = false
          notesProcessing = true

          updateHud(
            'NOTES\n\n' +
              'Generating notes...',
          )

          return
        }

        if (
          message.type ===
          'notes_saved'
        ) {
          notesActive = false
          notesProcessing = false

          updateHud(
            'NOTES SAVED\n\n' +
              String(
                message.title ||
                  'Session Notes',
              ) +
              '\n\nTap: back',
          )

          return
        }

        if (
          message.type ===
          'notes_error'
        ) {
          notesActive = false
          notesProcessing = false

          updateHud(
            'NOTES ERROR\n\n' +
              String(
                message.text ||
                  'Could not save.',
              ) +
              '\n\nTap: back',
          )

          return
        }
      } catch (error) {
        console.error(
          'Message error:',
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
      socket = null

      if (!intentionalExit) {
        scheduleReconnect()
      }
    }
}

connectSocket()

// ==================================================
// EVENT TYPE
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
    null
  )
}

// ==================================================
// EXIT
// ==================================================

function exitCopilot() {
  intentionalExit = true

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer,
    )

    reconnectTimer = null
  }

  bridge.audioControl(false)
  micStarted = false

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
      // ------------------------------------------

      if (
        event.audioEvent
          ?.audioPcm &&
        socketOpen()
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
        if (selectingMode) {
          changeMode(-1)
          return
        }

        if (selectingCourse) {
          changeCourse(-1)
          return
        }

        if (
          choosingContext ||
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
        if (selectingMode) {
          changeMode(1)
          return
        }

        if (selectingCourse) {
          changeCourse(1)
          return
        }

        if (choosingContext) {
          skipContext()
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
      // SINGLE TAP
      // ------------------------------------------

      if (
        sysType ===
          OsEventTypeList.CLICK_EVENT ||
        textType ===
          OsEventTypeList.CLICK_EVENT
      ) {
        // MODE SELECT
        if (selectingMode) {
          mode =
            modes[modeIndex]

          selectingMode = false

          sendControl({
            type: 'set_mode',
            mode,
          })

          enterSelectedMode()
          return
        }

        // SCHOOL COURSE SELECT
        if (selectingCourse) {
          selectCourse()
          return
        }

        // SALES / MEETING CONTEXT
        if (choosingContext) {
          startContextCapture()
          return
        }

        // CANCEL SPOKEN CONTEXT
        if (speakingContext) {
          cancelContextCapture()
          return
        }

        // CANCEL ASK
        if (manualAsk) {
          cancelManualAsk()
          return
        }

        // DISMISS CARD
        if (
          cardIndex >= 0
        ) {
          cardIndex = -1

          listeningScreen()
          return
        }

        // DISMISS NOTES STATUS
        if (notesProcessing) {
          listeningScreen()
          return
        }

        // ASK ME
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
        intentionalExit = true

        bridge.audioControl(false)
        micStarted = false

        if (socket) {
          socket.close()
        }

        unsubscribe()
      }
    },
  )