import { randomBytes } from "node:crypto";

export const EVAL_URL = process.env.EVAL_URL ?? "http://localhost:8791";
export const MODERN = "2026-07-28";
export const LEGACY = "2025-06-18";

const CLIENT_INFO = { name: "backchannels-eval", version: "1" };
export const TEST_SPACE = randomBytes(6).toString("hex");
const createdHeadlessAgents = new Map();

function parseBody(text) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

export function mcpClient(who, protocolVersion = MODERN, space = TEST_SPACE) {
  const url = `${EVAL_URL}/eval/${space}/${who}/mcp`;
  return mcpClientAt(url, protocolVersion);
}

export function headlessClient(key, protocolVersion = MODERN, space = "headless") {
  const client = mcpClientAt(`${EVAL_URL}/mcp`, protocolVersion, { authorization: `Bearer ${key}` });
  return {
    ...client,
    async call(tool, args = {}) {
      const result = await client.call(tool, args);
      if (tool === "register_agent" && result.ok && result.output.created) {
        const handle = result.output.handle;
        createdHeadlessAgents.set(JSON.stringify([space, handle]), { space, handle });
      }
      return result;
    },
  };
}

export async function cleanupHeadlessAgents() {
  for (const [id, { space, handle }] of createdHeadlessAgents) {
    const result = await evalRequest(`/eval/headless-admin?space=${space}`, "POST", {
      op: "revokeAgent",
      input: { handle },
      who: "fixture-cleanup",
      isAdmin: true,
    });
    if (!result.ok && result.error !== "not_found") throw new Error(`Could not clean up ${handle}: ${result.error}`);
    createdHeadlessAgents.delete(id);
  }
}

function mcpClientAt(url, protocolVersion, extraHeaders = {}) {
  let nextId = 1;

  async function request(method, params = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      ...extraHeaders,
    };
    let body = params;
    if (protocolVersion === MODERN) {
      headers["mcp-method"] = method;
      if (params.name) headers["mcp-name"] = params.name;
      body = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      };
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: body }),
    });
    const text = await response.text();
    let message;
    try {
      message = parseBody(text);
    } catch {
      throw new Error(`${method}: HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`);
    }
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }

  async function call(tool, args = {}) {
    const result = await request("tools/call", { name: tool, arguments: args });
    if (result.isError) return { ok: false, error: result.content?.[0]?.text ?? "unknown error" };
    return { ok: true, output: result.structuredContent };
  }

  async function handshake() {
    if (protocolVersion === MODERN) return request("server/discover");
    return request("initialize", { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO });
  }

  return { request, call, handshake };
}

export async function evalRequest(path, method = "GET", body) {
  const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const url = new URL(path, EVAL_URL);
  if (url.pathname.startsWith("/eval/") && !url.searchParams.has("space")) url.searchParams.set("space", TEST_SPACE);
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
