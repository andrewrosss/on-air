import type { Subprocess } from "bun";

type LogEventType = "camera_on" | "camera_off" | "mic_on" | "mic_off";
type LogState = { camera: boolean; mic: boolean };
type LogSubscriber = (
  state: LogState,
  event: LogEventType
) => void | Promise<void>;

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
          this.#subscribers.forEach((sub) => sub(this.#state, "camera_on"));
          this.#state.camera = true;
        } else if (line.includes("DisconnectClient")) {
          this.#subscribers.forEach((sub) => sub(this.#state, "camera_off"));
          this.#state.camera = false;
        } else if (line.includes("Starting {")) {
          this.#subscribers.forEach((sub) => sub(this.#state, "mic_on"));
          this.#state.mic = true;
        } else if (line.includes("Stopping {")) {
          this.#subscribers.forEach((sub) => sub(this.#state, "mic_off"));
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

function logSubscriberFactory(light: ILightController): LogSubscriber {
  return async (state, event) => {
    const logger = ConsoleLogger.get();
    logger.logInfo(`State = ${JSON.stringify(state)}, Event = ${event}`);
    if (event === "camera_on") await light.on();
    else if (event === "mic_on") await light.on();
    // only send off-air if both camera and mic are off
    else if (event === "camera_off" && !state.mic) await light.off();
    else if (event === "mic_off" && !state.camera) await light.off();
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

if (import.meta.main) {
  const light = LightController.fromEnv();
  const subscriber = logSubscriberFactory(light);
  const subscriberDebounced = debounce(subscriber, 500);
  const tailer = new LogTailer();
  tailer.subscribe(subscriberDebounced);
  tailer.start();

  const logger = ConsoleLogger.get();

  const port = Bun.env.PORT ?? 4417;
  logger.logInfo(`Starting server on port ${port}`);

  Bun.serve({
    port,
    fetch(req) {
      return new Response("Bun!");
    },
  });
}
