import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { wait } from "../commands/wait.js";
import { main } from "../main.js";
import { run } from "../machine.js";

const PUSH_EVENT = { reason: "dm", conversation: "dm:k7f2", message: "dm:k7f2/12", from: "@owner/agent" };
const EVENT_LINE = "backchannels: new dm from @owner/agent in dm:k7f2; call check_inbox, then run this command again";
const GENERIC_WAKE_LINE = "backchannels: new inbox item; call check_inbox, then run this command again";
const NO_MESSAGES_LINE = "backchannels: no new messages; run this command again";
const FAILURE_LINE = "backchannels: ticket expired or server unreachable; call watch_inbox for a new ticket";

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function createWebSocketServer(context: TestContext, onOpen: (socket: Duplex, request: IncomingMessage) => void, shouldReject = false) {
  const sockets = new Set<Duplex>();
  const server = createServer();
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => {
      if (error) { reject(error); return; }
      resolve();
    }));
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (shouldReject) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: bc-stream\r\n\r\n`);
    socket.on("data", (frame: Buffer) => {
      if ((frame[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0x00]));
    });
    onOpen(socket, request);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `ws://127.0.0.1:${address.port}/stream`;
}

function setTicketEnvironment(context: TestContext, ticket: string | undefined): void {
  const previousTicket = process.env.BACKCHANNELS_TICKET;
  context.after(() => {
    if (previousTicket === undefined) {
      delete process.env.BACKCHANNELS_TICKET;
      return;
    }
    process.env.BACKCHANNELS_TICKET = previousTicket;
  });
  if (ticket === undefined) {
    delete process.env.BACKCHANNELS_TICKET;
    return;
  }
  process.env.BACKCHANNELS_TICKET = ticket;
}

function captureOutput(context: TestContext) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  context.mock.method(console, "log", (line: string) => stdout.push(line));
  context.mock.method(console, "error", (line: string) => stderr.push(line));
  return { stdout, stderr };
}

test("wait prints the first event, closes the socket and returns zero", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  let closeObserved: Promise<void> | undefined;
  const url = await createWebSocketServer(context, socket => {
    closeObserved = new Promise(resolve => socket.once("end", resolve));
    socket.write(Buffer.concat([textFrame(JSON.stringify(PUSH_EVENT)), textFrame(JSON.stringify({ ...PUSH_EVENT, reason: "mention" }))]));
  });
  assert.equal(await wait(url, "test-ticket"), 0);
  await closeObserved;
  assert.deepEqual(output.stdout, [EVENT_LINE]);
  assert.deepEqual(output.stderr, []);
});

test("wait ignores non-JSON, non-object and binary frames before a valid event", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  const url = await createWebSocketServer(context, socket => {
    const invalidFrames = ["{", "null", "[]", "42", "\"dm\""];
    const binaryFrame = textFrame(JSON.stringify(PUSH_EVENT));
    binaryFrame[0] = 0x82;
    socket.write(Buffer.concat([binaryFrame, ...invalidFrames.map(textFrame)]));
    setImmediate(() => socket.write(textFrame(JSON.stringify(PUSH_EVENT))));
  });
  assert.equal(await wait(url, "test-ticket"), 0);
  assert.deepEqual(output.stdout, [EVENT_LINE]);
  assert.deepEqual(output.stderr, []);
});

test("wait wakes on a reason it does not know", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  const url = await createWebSocketServer(context, socket => {
    socket.write(textFrame(JSON.stringify({ ...PUSH_EVENT, reason: "reminder" })));
  });
  assert.equal(await wait(url, "test-ticket"), 0);
  assert.deepEqual(output.stdout, ["backchannels: new reminder from @owner/agent in dm:k7f2; call check_inbox, then run this command again"]);
  assert.deepEqual(output.stderr, []);
});

for (const [name, frame] of Object.entries({
  "an empty reason": { ...PUSH_EVENT, reason: "" },
  "a non-string sender": { ...PUSH_EVENT, from: 3 },
  "only a reason": { reason: "dm" },
  "a null message": { ...PUSH_EVENT, message: null },
  "a null conversation": { ...PUSH_EVENT, conversation: null },
  "no fields": {},
})) {
  test(`wait wakes with a generic line on an object with ${name}`, { timeout: 5000 }, async context => {
    const output = captureOutput(context);
    const url = await createWebSocketServer(context, socket => socket.write(textFrame(JSON.stringify(frame))));
    assert.equal(await wait(url, "test-ticket"), 0);
    assert.deepEqual(output.stdout, [GENERIC_WAKE_LINE]);
    assert.deepEqual(output.stderr, []);
  });
}

test("wait returns zero with no messages when the opened server closes", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  const url = await createWebSocketServer(context, socket => socket.end(Buffer.from([0x88, 0x00])));
  assert.equal(await wait(url, "test-ticket"), 0);
  assert.deepEqual(output.stdout, [NO_MESSAGES_LINE]);
  assert.deepEqual(output.stderr, []);
});

test("wait returns one on a rejected upgrade", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  const url = await createWebSocketServer(context, () => {}, true);
  assert.equal(await wait(url, "expired-ticket"), 1);
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, [FAILURE_LINE]);
});

test("wait reads the ticket from the environment and sends it only in the subprotocol header through the CLI", { timeout: 5000 }, async context => {
  const ticket = "private-ticket";
  setTicketEnvironment(context, ticket);
  let requestUrl: string | undefined;
  let protocols: string | string[] | undefined;
  const url = await createWebSocketServer(context, (socket, request) => {
    requestUrl = request.url;
    protocols = request.headers["sec-websocket-protocol"];
    socket.write(textFrame(JSON.stringify(PUSH_EVENT)));
  });
  const binaryPath = fileURLToPath(new URL("../../bin/backchannels.js", import.meta.url));
  const output = await run([process.execPath, binaryPath, "wait", url]);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stdout, `${EVENT_LINE}\n`);
  assert.equal(output.stderr, "");
  assert.equal(requestUrl, "/stream");
  assert.equal(protocols, `bc-stream, ${ticket}`);
});

test("wait returns zero when its internal limit expires", { timeout: 5000 }, async context => {
  const output = captureOutput(context);
  const url = await createWebSocketServer(context, () => {});
  assert.equal(await wait(url, "test-ticket", 50), 0);
  assert.deepEqual(output.stdout, [NO_MESSAGES_LINE]);
  assert.deepEqual(output.stderr, []);
});

test("wait reports constructor failures as unreachable", async context => {
  const output = captureOutput(context);
  assert.equal(await wait("invalid-url", "test-ticket"), 1);
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, [FAILURE_LINE]);
});

test("wait requires exactly one nonempty url and keeps other command argument checks", async context => {
  setTicketEnvironment(context, "ticket");
  const output = captureOutput(context);
  for (const arguments_ of [["wait"], ["wait", ""], ["wait", "ws://localhost", "ticket"], ["status", "extra"], ["install", "extra"]]) {
    assert.equal(await main(arguments_), 2);
  }
  assert.deepEqual(output.stdout, []);
  assert.ok(output.stderr.some(line => line.includes("BACKCHANNELS_TICKET=<ticket> backchannels wait <url>")));
});

for (const [name, ticket] of Object.entries({ "is missing": undefined, "is empty": "" })) {
  test(`wait is a usage error when BACKCHANNELS_TICKET ${name}`, async context => {
    setTicketEnvironment(context, ticket);
    const output = captureOutput(context);
    assert.equal(await main(["wait", "ws://localhost"]), 2);
    assert.deepEqual(output.stdout, []);
    assert.ok(output.stderr.some(line => line.includes("BACKCHANNELS_TICKET")));
  });
}
