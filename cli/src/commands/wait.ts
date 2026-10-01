import { hasErrorCode } from "../machine.js";

const WAIT_LIMIT_MS = 110 * 60 * 1000;
const SESSION_POLL_INTERVAL_MS = 30 * 1000;
const SESSION_ENDED = "backchannels: session ended";
const NO_MESSAGES = "backchannels: no new messages; run this command again";
const GENERIC_WAKE = "backchannels: new inbox item; call check_inbox, then run this command again";
const CONNECTION_FAILURE = "backchannels: ticket expired or server unreachable; call watch_inbox for a new ticket";

function wakeLineFor(frame: unknown): string | undefined {
  if (typeof frame !== "string") return;
  let event: unknown;
  try {
    event = JSON.parse(frame);
  } catch {
    return;
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) return;
  if (!("reason" in event) || typeof event.reason !== "string" || !event.reason) return GENERIC_WAKE;
  if (!("conversation" in event) || typeof event.conversation !== "string") return GENERIC_WAKE;
  if (!("message" in event) || typeof event.message !== "string") return GENERIC_WAKE;
  if (!("from" in event) || typeof event.from !== "string") return GENERIC_WAKE;
  return `backchannels: new ${event.reason} from ${event.from} in ${event.conversation}; call check_inbox, then run this command again`;
}

export async function wait(url: string, ticket: string, limitMs = WAIT_LIMIT_MS, sessionPollIntervalMs = SESSION_POLL_INTERVAL_MS, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url, ["bc-stream", ticket]);
  } catch {
    console.error(CONNECTION_FAILURE);
    return 1;
  }
  return new Promise<number>(resolve => {
    let hasOpened = false;
    let hasFinished = false;
    const timeout = setTimeout(() => finish(0, NO_MESSAGES), limitMs);
    const sessionPidText = environment.CLAUDE_PID ?? "";
    const sessionPid = Number(sessionPidText);
    const hasSessionPid = sessionPidText.length > 0 && !/[^0-9]/.test(sessionPidText) && Number.isSafeInteger(sessionPid) && sessionPid > 0;
    const sessionPollInterval = hasSessionPid ? setInterval(() => {
      try {
        process.kill(sessionPid, 0);
      } catch (error) {
        if (hasErrorCode(error, "ESRCH")) finish(0, SESSION_ENDED);
      }
    }, sessionPollIntervalMs) : undefined;

    function finish(exitCode: number, message: string): void {
      if (hasFinished) return;
      hasFinished = true;
      clearTimeout(timeout);
      clearInterval(sessionPollInterval);
      if (exitCode === 1) console.error(message);
      if (exitCode === 0) console.log(message);
      socket.close();
      resolve(exitCode);
    }

    function finishDisconnected(): void {
      if (!hasOpened) {
        finish(1, CONNECTION_FAILURE);
        return;
      }
      finish(0, NO_MESSAGES);
    }

    socket.addEventListener("open", () => { hasOpened = true; });
    socket.addEventListener("message", event => {
      const wakeLine = wakeLineFor(event.data);
      if (!wakeLine) return;
      finish(0, wakeLine);
    });
    socket.addEventListener("error", finishDisconnected);
    socket.addEventListener("close", finishDisconnected);
  });
}
