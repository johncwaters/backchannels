import { hasErrorCode } from "../machine.js";

const WAIT_LIMIT_MS = 110 * 60 * 1000;
const SESSION_POLL_INTERVAL_MS = 30 * 1000;
const SESSION_ENDED = "backchannels: session ended";
const WAIT_LIMIT_REACHED = "backchannels: wait limit reached; call check_inbox, then run this command again";
const GENERIC_WAKE = "backchannels: new inbox item; call check_inbox, then run this command again";
const CONNECTION_FAILURE = "backchannels: ticket expired or server unreachable; call watch_inbox for a new ticket";
const CONNECTION_LOST = "backchannels: connection lost, so new messages may have been missed; call check_inbox, then run this command again";
const POLICY_VIOLATION = 1008;
const MAX_CLOSE_REASON_LENGTH = 123;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_FAILED_RECONNECT_ATTEMPTS = 5;
const HEALTHY_SOCKET_DURATION_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

function serverClosedLine(reason: string): string {
  const printableReason = reason.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, MAX_CLOSE_REASON_LENGTH) || "no reason given";
  return `backchannels: the server closed this stream (${printableReason}); call check_inbox, and call watch_inbox only if you still need a stream`;
}

function wakeLineFor(frame: unknown): string | undefined {
  if (typeof frame !== "string") return;
  let event: unknown;
  try {
    event = JSON.parse(frame);
  } catch {
    return;
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) return;
  if ("type" in event && event.type === "cursor") return;
  if (!("reason" in event) || typeof event.reason !== "string" || !event.reason) return GENERIC_WAKE;
  if (!("conversation" in event) || typeof event.conversation !== "string") return GENERIC_WAKE;
  if (!("message" in event) || typeof event.message !== "string") return GENERIC_WAKE;
  if (!("from" in event) || typeof event.from !== "string") return GENERIC_WAKE;
  return `backchannels: new ${event.reason} from ${event.from} in ${event.conversation}; call check_inbox, then run this command again`;
}

export async function wait(url: string, ticket: string, limitMs = WAIT_LIMIT_MS, sessionPollIntervalMs = SESSION_POLL_INTERVAL_MS, environment: NodeJS.ProcessEnv = process.env, reconnectDelaysMs: readonly number[] = RECONNECT_DELAYS_MS, healthySocketDurationMs = HEALTHY_SOCKET_DURATION_MS, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, pongTimeoutMs = PONG_TIMEOUT_MS): Promise<number> {
  return new Promise<number>(resolve => {
    let socket: WebSocket | undefined;
    let hasOpened = false;
    let hasFinished = false;
    let resumeCursor: number | undefined;
    let failedReconnectAttempts = 0;
    let reconnectDelayIndex = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let stopHeartbeat = (): void => {};
    const timeout = setTimeout(() => finish(0, WAIT_LIMIT_REACHED), limitMs);
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
      clearTimeout(reconnectTimeout);
      stopHeartbeat();
      if (exitCode === 1) console.error(message);
      if (exitCode === 0) console.log(message);
      socket?.close();
      resolve(exitCode);
    }

    function scheduleReconnect(hasStayedHealthy: boolean, isReconnect: boolean): void {
      if (hasFinished) return;
      if (!hasOpened) {
        finish(1, CONNECTION_FAILURE);
        return;
      }
      if (hasStayedHealthy) {
        failedReconnectAttempts = 0;
        reconnectDelayIndex = 0;
      }
      if (!hasStayedHealthy && isReconnect) failedReconnectAttempts += 1;
      if (failedReconnectAttempts >= MAX_FAILED_RECONNECT_ATTEMPTS) {
        finish(1, CONNECTION_LOST);
        return;
      }
      const reconnectDelayMs = reconnectDelaysMs[Math.min(reconnectDelayIndex, reconnectDelaysMs.length - 1)];
      reconnectDelayIndex += 1;
      reconnectTimeout = setTimeout(connect, reconnectDelayMs);
    }

    function connect(): void {
      if (hasFinished) return;
      reconnectTimeout = undefined;
      const isReconnect = hasOpened;
      let currentSocket: WebSocket;
      try {
        const offeredProtocols = ["bc-stream", ticket, "bc-resume"];
        if (isReconnect && resumeCursor !== undefined) offeredProtocols.push(`bc-resume.${resumeCursor}`);
        currentSocket = new WebSocket(url, offeredProtocols);
      } catch {
        scheduleReconnect(false, isReconnect);
        return;
      }
      socket = currentSocket;
      let didOpen = false;
      let openedAtMs = 0;
      let hasDisconnected = false;
      let receivePong = (): void => {};

      function disconnect(): void {
        if (hasFinished || hasDisconnected || socket !== currentSocket) return;
        hasDisconnected = true;
        stopHeartbeat();
        currentSocket.close();
        scheduleReconnect(didOpen && Date.now() - openedAtMs >= healthySocketDurationMs, isReconnect);
      }

      currentSocket.addEventListener("open", () => {
        if (hasFinished || hasDisconnected || socket !== currentSocket) return;
        didOpen = true;
        openedAtMs = Date.now();
        hasOpened = true;
        let pongDeadline: ReturnType<typeof setTimeout> | undefined;
        const heartbeat = setInterval(() => {
          currentSocket.send("ping");
          pongDeadline ??= setTimeout(disconnect, pongTimeoutMs);
        }, heartbeatIntervalMs);
        stopHeartbeat = () => {
          clearInterval(heartbeat);
          clearTimeout(pongDeadline);
        };
        receivePong = () => {
          clearTimeout(pongDeadline);
          pongDeadline = undefined;
        };
      });
      currentSocket.addEventListener("message", event => {
        if (hasFinished || hasDisconnected || socket !== currentSocket) return;
        if (event.data === "pong") {
          receivePong();
          return;
        }
        if (resumeCursor === undefined && typeof event.data === "string") {
          try {
            const frame: unknown = JSON.parse(event.data);
            if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && "type" in frame && frame.type === "cursor" && "cursor" in frame && typeof frame.cursor === "number" && Number.isSafeInteger(frame.cursor) && frame.cursor >= 0) {
              resumeCursor = frame.cursor;
            }
          } catch {
            return;
          }
        }
        const wakeLine = wakeLineFor(event.data);
        if (!wakeLine) return;
        finish(0, wakeLine);
      });
      currentSocket.addEventListener("error", disconnect);
      currentSocket.addEventListener("close", event => {
        if (hasFinished || hasDisconnected || socket !== currentSocket) return;
        if (didOpen && event.code === POLICY_VIOLATION) {
          finish(1, serverClosedLine(event.reason));
          return;
        }
        disconnect();
      });
    }

    connect();
  });
}
