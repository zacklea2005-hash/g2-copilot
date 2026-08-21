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
  'ws://192.168.178.191:3001/audio'

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

  company?: string
  body?: string
  questions?: string[]
}

// ==================================================
// STATE
// ==================================================

let mode: Mode =
  'SALES'

const modes: Mode[] = [
  'SALES',
  'GENERAL',
  'MEETING',
  'SCHOOL',
]

let modeIndex = 0

let selectingMode =
  true

let manualAsk =
  false

const cards: Card[] =
  []

let cardIndex =
  -1

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
    textObject: [mainText],
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
  const current =
    modes[modeIndex]

  updateHud(
    'SELECT MODE\n\n' +
      `> ${current}\n\n` +
      '↑ ↓ change\n' +
      'Tap: start',
  )
}

function changeMode(
  direction: number,
) {
  modeIndex +=
    direction

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
// LISTENING
// ==================================================

function listeningScreen() {
  updateHud(
    `${mode} MODE\n\nListening...\n\nTap: ask me\n↑: last card`,
  )
}

// ==================================================
// CARD RENDERING
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
      (card.body ||
        '') +
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
    (card.body ||
      '') +
    '\n\n↑ previous   ↓ next'
  )
}

function showCurrentCard() {
  if (
    cardIndex < 0 ||
    cards.length ===
      0
  ) {
    cardIndex =
      -1

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
}

function addCard(
  card: Card,
) {
  cards.push(
    card,
  )

  if (
    cards.length >
    12
  ) {
    cards.shift()

    if (
      cardIndex > 0
    ) {
      cardIndex -= 1
    }
  }

  // Do not replace a card
  // currently being read.
  if (
    cardIndex ===
      -1 &&
    !manualAsk
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard()
  }
}

// ==================================================
// CARD NAVIGATION
// ==================================================

function previousCard() {
  if (
    cards.length ===
    0
  ) {
    listeningScreen()

    return
  }

  if (
    cardIndex ===
    -1
  ) {
    cardIndex =
      cards.length - 1

    showCurrentCard()

    return
  }

  if (
    cardIndex > 0
  ) {
    cardIndex -= 1
  }

  showCurrentCard()
}

function nextCard() {
  if (
    cards.length ===
    0
  ) {
    listeningScreen()

    return
  }

  if (
    cardIndex ===
    -1
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

  cardIndex =
    -1

  listeningScreen()
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

socket.onopen =
  async () => {
    console.log(
      'Connected to server',
    )

    const micStarted =
      await bridge.audioControl(
        true,
      )

    if (
      !micStarted
    ) {
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

      if (
        message.type ===
        'manual_answer'
      ) {
        manualAsk =
          false

        updateHud(
          'ANSWER\n\n' +
            String(
              message.text,
            ) +
            '\n\nTap: back',
        )

        return
      }

      if (
        message.type ===
        'mode_changed'
      ) {
        mode =
          message.mode as Mode

        listeningScreen()
      }
    } catch (error) {
      console.error(
        'Message error:',
        error,
      )
    }
  }

socket.onerror =
  () => {
    updateHud(
      'G2 COPILOT\n\nServer connection failed.',
    )
  }

socket.onclose =
  () => {
    updateHud(
      'G2 COPILOT\n\nServer disconnected.',
    )
  }

// ==================================================
// SEND CONTROL
// ==================================================

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
// MANUAL ASK
// ==================================================

function startManualAsk() {
  manualAsk =
    true

  cardIndex =
    -1

  sendControl({
    type:
      'manual_ask_start',
  })

  updateHud(
    'ASK ME\n\nSpeak your question...\n\nTap: cancel',
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
// EVENTS
// ==================================================

const unsubscribe =
  bridge.onEvenHubEvent(
    event => {
      // -----------------------------
      // AUDIO
      // -----------------------------

      if (
        event.audioEvent
          ?.audioPcm &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        const pcm =
          event.audioEvent
            .audioPcm

        const audioBuffer =
          new Uint8Array(
            pcm,
          ).buffer

        socket.send(
          audioBuffer,
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

      // -----------------------------
      // DOUBLE TAP EXIT
      // -----------------------------

      if (
        sysType ===
          OsEventTypeList.DOUBLE_CLICK_EVENT ||
        textType ===
          OsEventTypeList.DOUBLE_CLICK_EVENT
      ) {
        exitCopilot()

        return
      }

      // -----------------------------
      // SWIPE UP
      // -----------------------------

      if (
        sysType ===
          OsEventTypeList.SCROLL_TOP_EVENT ||
        textType ===
          OsEventTypeList.SCROLL_TOP_EVENT
      ) {
        if (
          selectingMode
        ) {
          changeMode(
            -1,
          )

          return
        }

        if (
          manualAsk
        ) {
          return
        }

        previousCard()

        return
      }

      // -----------------------------
      // SWIPE DOWN
      // -----------------------------

      if (
        sysType ===
          OsEventTypeList.SCROLL_BOTTOM_EVENT ||
        textType ===
          OsEventTypeList.SCROLL_BOTTOM_EVENT
      ) {
        if (
          selectingMode
        ) {
          changeMode(
            1,
          )

          return
        }

        if (
          manualAsk
        ) {
          return
        }

        nextCard()

        return
      }

      // -----------------------------
      // SINGLE TAP
      // -----------------------------

      if (
        sysType ===
          OsEventTypeList.CLICK_EVENT ||
        textType ===
          OsEventTypeList.CLICK_EVENT
      ) {
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

          listeningScreen()

          return
        }

        if (
          manualAsk
        ) {
          cancelManualAsk()

          return
        }

        // If viewing card,
        // return to listening.
        if (
          cardIndex >=
          0
        ) {
          cardIndex =
            -1

          listeningScreen()

          return
        }

        // From listening:
        // start manual ask.
        startManualAsk()

        return
      }

      // -----------------------------
      // SYSTEM EXIT
      // -----------------------------

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