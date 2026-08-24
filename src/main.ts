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
// STATE
// ==================================================

const modes: Mode[] = [
  'SALES',
  'GENERAL',
  'MEETING',
  'SCHOOL',
]

let mode: Mode =
  'SALES'

let modeIndex = 0

let selectingMode = true
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
  | ReturnType<
      typeof setTimeout
    >
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
// CONTEXT
// ==================================================

function showContextChoice() {
  selectingMode = false
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
    type:
      'context_start',
  })

  updateHud(
    'PREPARING CONTEXT\n\n' +
      'Speak now...\n\n' +
      'Tap: cancel',
  )
}

function cancelContextCapture() {
  speakingContext = false
  choosingContext = false

  sendControl({
    type:
      'context_skip',
  })

  listeningScreen()
}

function skipContext() {
  choosingContext = false
  speakingContext = false
  currentContext = null

  sendControl({
    type:
      'context_skip',
  })

  listeningScreen()
}

// ==================================================
// LISTENING
// ==================================================

function listeningScreen() {
  selectingMode = false
  choosingContext = false
  speakingContext = false

  const notes =
    notesActive
      ? 'NOTES: RECORDING'
      : notesProcessing
        ? 'NOTES: SAVING...'
        : 'NOTES: OFF'

  const contextLabel =
    currentContext?.company ||
    currentContext?.course ||
    currentContext?.topic ||
    ''

  updateHud(
    `${mode} MODE\n` +
      (
        contextLabel
          ? `${contextLabel}\n`
          : ''
      ) +
      `${notes}\n\n` +
      'Tap: ask me\n' +
      '↓ notes · ↑ cards',
  )
}

// ==================================================
// CARD DISPLAY
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
        card.questions ||
        []
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

// Important:
// If a bundle sends three cards,
// display the FIRST card and queue
// the others behind it.
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
    !choosingContext
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

  const startIndex =
    cards.length

  for (
    const card of
    briefing
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
      startIndex -
        Math.max(
          0,
          startIndex +
            briefing.length -
            20,
        ),
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
      type:
        'notes_start',
    })

    updateHud(
      'NOTES\n\nRecording started...',
    )

    setTimeout(
      listeningScreen,
      800,
    )

    return
  }

  notesActive = false
  notesProcessing = true

  sendControl({
    type:
      'notes_stop',
  })

  updateHud(
    'NOTES\n\nGenerating notes...',
  )
}

// ==================================================
// ASK ME
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
      'Commands:\n' +
      '"new session"',
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
      2000 *
        reconnectAttempts,
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

        connectSocket(
          true,
        )
      },
      delay,
    )
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
    micStarted = true
  }

  return started
}

// ==================================================
// SOCKET CONNECTION
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
          'G2 COPILOT\n\nMicrophone failed.',
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
          'G2 COPILOT\n\nReconnected...',
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
        // CARD
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

          const foundIndex =
            modes.indexOf(
              mode,
            )

          if (
            foundIndex >= 0
          ) {
            modeIndex =
              foundIndex
          }

          return
        }

        // ------------------------------------------
        // CONTEXT READY + BRIEFING
        // ------------------------------------------

        if (
          message.type ===
          'context_ready'
        ) {
          speakingContext = false
          choosingContext = false

          currentContext =
            message.context || null

          const summary =
            String(
              message.context
                ?.summary ||
                'Context loaded',
            )

          const briefing =
            Array.isArray(
              message.briefing,
            )
              ? (
                  message.briefing as Card[]
                )
              : []

          updateHud(
            'CONTEXT READY\n\n' +
              summary +
              '\n\nBriefing ready...',
          )

          setTimeout(
            () => {
              addBriefingCards(
                briefing,
              )
            },
            1200,
          )

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
              modes.indexOf(
                mode,
              )

            if (index >= 0) {
              modeIndex = index
            }
          }

          updateHud(
            'NEW SESSION\n\n' +
              `${mode} MODE\n\n` +
              'Choose new context...',
          )

          setTimeout(
            showContextChoice,
            900,
          )

          return
        }

        // ------------------------------------------
        // RECONNECT RESTORE
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
            'NOTES\n\nGenerating notes...',
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
// EVENT HELPER
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
  intentionalExit = true

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer,
    )

    reconnectTimer = null
  }

  bridge.audioControl(
    false,
  )

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
        // SELECT MODE
        if (selectingMode) {
          mode =
            modes[modeIndex]

          selectingMode = false

          sendControl({
            type:
              'set_mode',

            mode,
          })

          showContextChoice()

          return
        }

        // CHOOSE CONTEXT
        if (choosingContext) {
          startContextCapture()

          return
        }

        // CANCEL CONTEXT CAPTURE
        if (speakingContext) {
          cancelContextCapture()

          return
        }

        // CANCEL ASK ME
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

        // START ASK ME
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

        bridge.audioControl(
          false,
        )

        micStarted = false

        if (socket) {
          socket.close()
        }

        unsubscribe()
      }
    },
  )