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

const cards: Card[] = []

let cardIndex = -1

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
// SOCKET
// ==================================================

const socket =
  new WebSocket(
    SERVER_URL,
  )

socket.binaryType =
  'arraybuffer'

function sendControl(
  payload: object,
) {
  if (
    socket.readyState ===
    WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify(
        payload,
      ),
    )
  }
}

// ==================================================
// MODE MENU
// ==================================================

function showModeMenu() {
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

  if (
    modeIndex < 0
  ) {
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
// CONTEXT SETUP
// ==================================================

function showContextChoice() {
  choosingContext = true

  updateHud(
    'ADD CONTEXT?\n\n' +
      'Tap: speak context\n' +
      '↓: skip\n\n' +
      'Example:\n' +
      '"STAT 340 regression"',
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
    'SET CONTEXT\n\n' +
      'Speak now...\n\n' +
      'Example:\n' +
      '"ServiceNow AI meeting"',
  )
}

function skipContext() {
  choosingContext = false
  speakingContext = false

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
  const notes =
    notesActive
      ? 'NOTES: RECORDING'
      : notesProcessing
        ? 'NOTES: SAVING...'
        : 'NOTES: OFF'

  updateHud(
    `${mode} MODE\n\n` +
      `${notes}\n\n` +
      'Tap: ask me\n' +
      '↓: notes on/off\n' +
      '↑: last card',
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

function addCard(
  card: Card,
) {
  cards.push(card)

  if (
    cards.length > 15
  ) {
    cards.shift()

    if (
      cardIndex > 0
    ) {
      cardIndex -= 1
    }
  }

  if (
    cardIndex === -1 &&
    !manualAsk &&
    !speakingContext &&
    !choosingContext
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard()
  }
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
// NOTES
// ==================================================

function toggleNotes() {
  if (
    notesProcessing
  ) {
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
      900,
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
      'Tap: cancel',
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
// SERVER EVENTS
// ==================================================

socket.onopen =
  async () => {
    console.log(
      'Connected to cloud server',
    )

    const micStarted =
      await bridge.audioControl(
        true,
      )

    if (!micStarted) {
      updateHud(
        'G2 COPILOT\n\nMicrophone failed.',
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
      // CARDS
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
      // CONTEXT
      // ------------------------------------------

      if (
        message.type ===
        'context_ready'
      ) {
        speakingContext = false
        choosingContext = false

        const summary =
          String(
            message.context
              ?.summary ||
              'Context loaded',
          )

        updateHud(
          'CONTEXT READY\n\n' +
            summary,
        )

        setTimeout(
          listeningScreen,
          1800,
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

      // ------------------------------------------
      // MODE
      // ------------------------------------------

      if (
        message.type ===
        'mode_changed'
      ) {
        mode =
          message.mode as Mode

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

    updateHud(
      'G2 COPILOT\n\nCloud connection failed.',
    )
  }

socket.onclose =
  () => {
    updateHud(
      'G2 COPILOT\n\nCloud server disconnected.',
    )
  }

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
  bridge.audioControl(
    false,
  )

  if (
    socket.readyState ===
      WebSocket.OPEN ||
    socket.readyState ===
      WebSocket.CONNECTING
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
        socket.readyState ===
          WebSocket.OPEN
      ) {
        socket.send(
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
        if (
          selectingMode
        ) {
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
        if (
          selectingMode
        ) {
          changeMode(1)

          return
        }

        if (
          choosingContext
        ) {
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
        if (
          selectingMode
        ) {
          mode =
            modes[
              modeIndex
            ]

          selectingMode = false

          sendControl({
            type:
              'set_mode',

            mode,
          })

          showContextChoice()

          return
        }

        // CONTEXT CHOICE
        if (
          choosingContext
        ) {
          startContextCapture()

          return
        }

        // CONTEXT IS LISTENING
        if (
          speakingContext
        ) {
          return
        }

        // MANUAL ASK CANCEL
        if (
          manualAsk
        ) {
          cancelManualAsk()

          return
        }

        // DISMISS CURRENT CARD
        if (
          cardIndex >= 0
        ) {
          cardIndex = -1

          listeningScreen()

          return
        }

        // RETURN AFTER NOTES
        if (
          notesProcessing
        ) {
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
        bridge.audioControl(
          false,
        )

        if (
          socket.readyState ===
            WebSocket.OPEN ||
          socket.readyState ===
            WebSocket.CONNECTING
        ) {
          socket.close()
        }

        unsubscribe()
      }
    },
  )