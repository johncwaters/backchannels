export const EVAL_URL = process.env.EVAL_URL ?? "http://localhost:8791";
export const MODERN = "2026-07-28";
export const LEGACY = "2025-06-18";

const CLIENT_INFO = { name: "backchannels-eval", version: "1" };

function parseBody(text) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text);
}

export function mcpClient(who, protocolVersion = MODERN) {
  let nextId = 1;
  const url = `${EVAL_URL}/eval/${who}/mcp`;

  async function request(method, params = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
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

export async function evalPost(path) {
  const response = await fetch(`${EVAL_URL}${path}`, { method: "POST" });
  return response.json();
}
