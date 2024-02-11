import type { Subprocess } from "bun";

const MAKER_WEBHOOK_KEY = nullthrows(Bun.env.MAKER_WEBHOOK_KEY);
const MAKER_ON_AIR_EVENT = nullthrows(Bun.env.MAKER_ON_AIR_EVENT);
const MAKER_OFF_AIR_EVENT = nullthrows(Bun.env.MAKER_OFF_AIR_EVENT);

type MediaEventType = "camera_on" | "camera_off" | "mic_on" | "mic_off";
type MediaEventHandler = (
  state: MediaState,
  event: MediaEventType
) => void | Promise<void>;
type MediaState = { camera: boolean; mic: boolean };

class MediaListener {
  #callbacks: Array<MediaEventHandler> = [];
  #process: Subprocess<"ignore", "pipe", "inherit"> | null = null;
  #state: MediaState = { camera: false, mic: false };

  addHandler(callback: MediaEventHandler) {
    this.#callbacks.push(callback);
  }

  removeHandler(callback: MediaEventHandler) {
    this.#callbacks = this.#callbacks.filter((cb) => cb !== callback);
  }

  async start() {
    console.log("Starting media listener");

    // TODO: make this work for different mac versions
    // TODO: make this configurable
    this.#process = Bun.spawn([
      "log",
      "stream",
      "--predicate",
      'sender contains "appleh13camerad" and (composedMessage contains "ConnectClient" or composedMessage contains "DisconnectClient")',
    ]);

    try {
      // @ts-expect-error
      for await (const chunk of this.#process.stdout) {
        const line = Buffer.from(chunk).toString("utf-8");

        // TODO: if verbose mode, log all lines

        // don't log the log filtering message
        if (line.includes("Filtering the log data using")) continue;

        if (line.includes("ConnectClient")) {
          this.#state.camera = true;
          this.#callbacks.forEach((cb) => cb(this.#state, "camera_on"));
        } else if (line.includes("DisconnectClient")) {
          this.#state.camera = false;
          this.#callbacks.forEach((cb) => cb(this.#state, "camera_off"));
        } else {
          console.log("Unknown log line:", line);
        }
      }
    } catch (err) {
      console.error("Error reading log stream:", err);
    }
  }
}

async function defaultHandler(state: MediaState, curr: MediaEventType) {
  console.log(`State = ${JSON.stringify(state)}, Current = ${curr}`);
  if (curr === "camera_on") await sendOnAir();
  else if (curr === "mic_on") await sendOnAir();
  // only send off-air if both camera and mic are off
  else if (curr === "camera_off" && !state.mic) await sendOffAir();
  else if (curr === "mic_off" && !state.camera) await sendOffAir();
}

// TODO: debounce the handlers
async function sendOnAir() {
  const url = `https://maker.ifttt.com/trigger/${MAKER_ON_AIR_EVENT}/with/key/${MAKER_WEBHOOK_KEY}`;
  const init = { method: "POST" };
  return await fetch(url, init);
}

async function sendOffAir() {
  const url = `https://maker.ifttt.com/trigger/${MAKER_OFF_AIR_EVENT}/with/key/${MAKER_WEBHOOK_KEY}`;
  const init = { method: "POST" };
  return await fetch(url, init);
}

function nullthrows<T>(value: T | null | undefined, message?: string): T {
  if (value != null) {
    return value;
  }
  throw new Error(message || "Got unexpected null or undefined value");
}

if (import.meta.main) {
  const listener = new MediaListener();
  listener.addHandler(defaultHandler);
  listener.start();

  Bun.serve({
    fetch(req) {
      return new Response("Bun!");
    },
  });
}
