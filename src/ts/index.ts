import type { Subprocess } from "bun";

type LogEvent = {
  type: "camera_on" | "camera_off" | "mic_on" | "mic_off";
  camera: boolean;
  mic: boolean;
};
type LogState = Pick<LogEvent, "camera" | "mic">;
type LogSubscriber = (event: LogEvent) => void | Promise<void>;

class LogTailer {
  #subscribers: Array<LogSubscriber> = [];
  #process: Subprocess<"ignore", "pipe", "inherit"> | null = null;
  #state: LogState = { camera: false, mic: false };

  subscribe(subscriber: LogSubscriber) {
    this.#subscribers.push(subscriber);
    return () => {
      this.#subscribers = this.#subscribers.filter((sub) => sub !== subscriber);
    };
  }

  unsubscribe(subscriber: LogSubscriber) {
    this.#subscribers = this.#subscribers.filter((sub) => sub !== subscriber);
  }

  get state() {
    return this.#state;
  }

  async start() {
    const logger = ConsoleLogger.get();
    logger.logInfo("Starting log tailer");

    // TODO: make this work for different mac versions
    // TODO: make this configurable
    this.#process = Bun.spawn([
      "log",
      "stream",
      "--predicate",
      [
        // camera
        '(process == "appleh13camerad" and (composedMessage contains "ConnectClient" or composedMessage contains "DisconnectClient"))',
        // mic
        '(process == "coreaudiod" and subsystem == "com.apple.coreaudio" and (composedMessage contains "Starting {" or composedMessage contains "Stopping {"))',
      ].join(" or "),
    ]);

    try {
      // @ts-expect-error
      for await (const chunk of this.#process.stdout) {
        const line = Buffer.from(chunk).toString("utf-8");

        logger.logDebug(line);

        // don't log the log filtering message
        if (line.includes("Filtering the log data using")) continue;

        if (line.includes("ConnectClient")) {
          const event = { type: "camera_on", ...this.#state } as const;
          this.#subscribers.forEach((sub) => sub(event));
          this.#state.camera = true;
        } else if (line.includes("DisconnectClient")) {
          const event = { type: "camera_off", ...this.#state } as const;
          this.#subscribers.forEach((sub) => sub(event));
          this.#state.camera = false;
        } else if (line.includes("Starting {")) {
          const event = { type: "mic_on", ...this.#state } as const;
          this.#subscribers.forEach((sub) => sub(event));
          this.#state.mic = true;
        } else if (line.includes("Stopping {")) {
          const event = { type: "mic_off", ...this.#state } as const;
          this.#subscribers.forEach((sub) => sub(event));
          this.#state.mic = false;
        } else {
          logger.logInfo("Unknown log line:", line);
        }
      }
    } catch (err) {
      console.error("Error reading log stream:", err);
    }
  }
}

interface ILightController {
  on(): Promise<void>;
  off(): Promise<void>;
}

class LightController implements ILightController {
  constructor(private onURL: string, private offURL: string) {}

  static fromEnv() {
    const MAKER_WEBHOOK_KEY = nullthrows(Bun.env.MAKER_WEBHOOK_KEY);
    const MAKER_ON_AIR_EVENT = nullthrows(Bun.env.MAKER_ON_AIR_EVENT);
    const MAKER_OFF_AIR_EVENT = nullthrows(Bun.env.MAKER_OFF_AIR_EVENT);

    const onURL = `https://maker.ifttt.com/trigger/${MAKER_ON_AIR_EVENT}/with/key/${MAKER_WEBHOOK_KEY}`;
    const offURL = `https://maker.ifttt.com/trigger/${MAKER_OFF_AIR_EVENT}/with/key/${MAKER_WEBHOOK_KEY}`;

    return new LightController(onURL, offURL);
  }

  async on() {
    const logger = ConsoleLogger.get();
    logger.logInfo("Turning light ON");
    await fetch(this.onURL, { method: "POST" });
  }

  async off() {
    const logger = ConsoleLogger.get();
    logger.logInfo("Turning light OFF");
    await fetch(this.offURL, { method: "POST" });
  }
}

type WSEvent = { type: "on_air" | "off_air" };
type PubSubEvent = LogEvent | WSEvent; // TODO: Add UI-driven events
type PubSubSubscriber = (e: PubSubEvent) => void | Promise<void>;

class PubSub {
  #subscribers: Array<PubSubSubscriber> = [];

  subscribe(subscriber: (e: PubSubEvent) => void) {
    this.#subscribers.push(subscriber);
    return () => {
      this.#subscribers = this.#subscribers.filter((sub) => sub !== subscriber);
    };
  }

  publish(event: PubSubEvent) {
    this.#subscribers.forEach((sub) => sub(event));
  }
}

// --- Utility functions ---

/**
 * handles events from the log tailer and toggles the light on and off
 */
function hardwareSubscriberFactory(light: ILightController): PubSubSubscriber {
  return async (event) => {
    const logger = ConsoleLogger.get();

    switch (event.type) {
      case "camera_on":
      case "camera_off":
      case "mic_on":
      case "mic_off": {
        const { type: _type, ...state } = event;
        logger.logInfo(`EventType: ${_type}, State: ${JSON.stringify(state)}`);
        if (_type === "camera_on") await light.on();
        else if (_type === "mic_on") await light.on();
        // only send off-air if both camera and mic are off
        else if (_type === "camera_off" && !state.mic) await light.off();
        else if (_type === "mic_off" && !state.camera) await light.off();
        return;
      }
    }
  };
}

/**
 * handles on_air events from the frontend and turns the light on
 */
function onAirSubscriberFactory(light: ILightController): PubSubSubscriber {
  return async (event) => {
    const logger = ConsoleLogger.get();
    if (event.type !== "on_air") return;
    logger.logInfo(`EventType = ${event.type}`);
    await light.on();
  };
}

/**
 * handles off_air events from the frontend and turns the light off
 */
function offAirSubscriberFactory(light: ILightController): PubSubSubscriber {
  return async (event) => {
    const logger = ConsoleLogger.get();
    if (event.type !== "off_air") return;
    logger.logInfo(`EventType = ${event.type}`);
    await light.off();
  };
}

function nullthrows<T>(value: T | null | undefined, message?: string): T {
  if (value != null) {
    return value;
  }
  throw new Error(message || "Got unexpected null or undefined value");
}

function debounce<F extends (...args: any[]) => any>(
  func: F,
  delay: number // in milliseconds
): (...args: Parameters<F>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return async function (this: any, ...args: Parameters<F>) {
    timeout != null && clearTimeout(timeout);
    timeout = setTimeout(async () => func.apply(this, args), delay);
  };
}

function throttle<F extends (...args: any[]) => any>(
  func: F,
  delay: number // in milliseconds
): (...args: Parameters<F>) => void {
  let t_prev: number = 0;
  return async function (this: any, ...args: Parameters<F>) {
    const now = Date.now();
    if (now - t_prev >= delay) {
      t_prev = now;
      return func.apply(this, args);
    }
  };
}

// A chintzy singleton logger. Get the instance with `ConsoleLogger.get()`
class ConsoleLogger {
  private static instance: ConsoleLogger | null = null;
  private constructor() {}

  static get() {
    if (!this.instance) this.instance = new ConsoleLogger();
    return this.instance;
  }

  logInfo(...data: any[]) {
    const date_str = new Date().toISOString();
    console.log(`[${date_str}][INFO]`, ...data);
  }

  logError(...data: any[]) {
    const date_str = new Date().toISOString();
    console.error(`[${date_str}][ERROR]`, ...data);
  }

  logDebug(...data: any[]) {
    if (!!Bun.env.VERBOSE || !!Bun.env.DEBUG) {
      const date_str = new Date().toISOString();
      console.log(`[${date_str}][DEBUG]`, ...data);
    }
  }
}

// --- Main ---

if (import.meta.main) {
  // create our light controller and make subscribers for pubsub events
  const light = LightController.fromEnv();
  const hardwareSubscriber = hardwareSubscriberFactory(light);
  const onAirSubscriber = onAirSubscriberFactory(light);
  const offAirSubscriber = offAirSubscriberFactory(light);

  // NOTE: the hardwareSubscriber is debounced, and the onAirSubscriber and
  //       offAirSubscriber are throttled. This is because the hardware
  //       events can be very chatty and we don't want to spam the light
  //       controller with requests. The on_air and off_air events are
  //       throttled because we also don't want to spam the light controller
  //       with requests, but we do want to register the first on_air and
  //       off_air events from the frontend as quickly as possible.
  //
  //       We split the on_air and off_air events into separate subscribers
  //       so that we can throttle them independently, this way even if
  //       you're getting throttled for off_air events, you can still send
  //       on_air events and they will be handled immediately (and vice versa)

  // create pubsub and wire up the light subscriber
  const pubsub = new PubSub();
  pubsub.subscribe(debounce(hardwareSubscriber, 500));
  pubsub.subscribe(throttle(onAirSubscriber, 500));
  pubsub.subscribe(throttle(offAirSubscriber, 500));

  // create a log tailer and forward events to pubsub
  const tailer = new LogTailer();
  tailer.subscribe((event) => pubsub.publish(event));
  tailer.start();

  const logger = ConsoleLogger.get();

  const port = Bun.env.PORT ?? 4417;
  logger.logInfo(`Starting server on port ${port}`);

  Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      logger.logInfo(`${req.method} ${url.pathname}`);
      if (url.pathname === "/") {
        const body = indexHtml(port);
        const init = { headers: { "Content-Type": "text/html" } };
        return new Response(body, init);
      } else if (url.pathname === "/live") {
        if (server.upgrade(req)) return; // do not return a Response if upgrading
        return new Response("Upgrade failed :(", { status: 500 });
      } else {
        return new Response("Bun!");
      }
    },
    websocket: {
      open(ws) {
        // super jank, but the frontend only checks for `event.type`
        // that contain the strings "on" or "off", so we can just
        // send the event type as the string "on" or "off" and the
        // frontend will update the UI accordingly.
        if (tailer.state.camera || tailer.state.mic) {
          ws.send(JSON.stringify({ type: "on" }));
        } else if (!tailer.state.camera && !tailer.state.mic) {
          ws.send(JSON.stringify({ type: "off" }));
        }
        // TODO: how to unsubscribe??
        pubsub.subscribe((event) => ws.send(JSON.stringify(event)));
      },
      message(ws, message) {
        // IMPORTANT: this is going to cause the same event to be sent _back_
        //            to the frontend. This is OK because the frontend will
        //            simply try to update the UI, which should be consistent
        //            with this event anyway.
        //
        //            In fact, this is probably desireable because the frontend
        //            only updates the UI in response to these events, moreover,
        //            if multiple tabs are open, they will all be in sync
        //            becuase they will all receive the same events via the
        //            PubSub subscription setup in the `open` handler.
        const event = JSON.parse(String(message));
        pubsub.publish(event);
      },
      close(ws, code, message) {
        // TODO: AGAIN - how to unsubscribe?? How to get the callback or
        //       unsubscribe function from the open handler?
      },
    },
  });
}

const indexHtml = (port: string | number) => `\
<!DOCTYPE html>
<html>
  <head>
    <title>On Air</title>
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
      }

      html,
      body {
        min-block-size: 100%;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
          sans-serif;
      }

      body {
        display: grid;
        place-content: center;
        align-items: center;
        margin: 0;
      }

      .button {
        padding: 10px 20px;
        font-size: 16px;
        border-radius: 5px;
        cursor: pointer;
      }

      .on {
        background-color: #4caf50;
        color: white;
      }

      .off {
        background-color: #f44336;
        color: white;
      }
    </style>
  </head>
  <body>
    <button id="onButton" class="button">On</button>
    <button id="offButton" class="button">Off</button>

    <script>
      const onButton = document.getElementById("onButton");
      const offButton = document.getElementById("offButton");

      // Setup WebSocket connection
      const socket = new WebSocket("ws://localhost:${port}/live");

      // Function to send event over WebSocket
      function sendEvent(type) {
        const event = { type };
        socket.send(JSON.stringify(event));
      }

      // Function to handle received events
      function handleEvent(event) {
        if (event.type.includes("on")) {
          onButton.classList.add("on");
          offButton.classList.remove("off");
        } else if (event.type.includes("off")) {
          offButton.classList.add("off");
          onButton.classList.remove("on");
        }
      }

      // Event listeners for button clicks
      onButton.addEventListener("click", () => {
        sendEvent("on_air");
      });

      offButton.addEventListener("click", () => {
        sendEvent("off_air");
      });

      // Event listener for received WebSocket messages
      socket.addEventListener("message", (event) => {
        const receivedEvent = JSON.parse(event.data);
        handleEvent(receivedEvent);
      });
    </script>
  </body>
</html>
`;
