export const JEEVES = {
  url: "https://ai-gateway.us.posthog.com/v1/systemone",
  model: "posthog/hogference/jeeves-0.1",
  timeoutMs: 5_000,
} as const;

export interface YesNoQuestion {
  instructions: string;
  criteria?: string;
}

export type JeevesResult =
  | { ok: true; probabilities: Map<string, number>; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function probabilityOf(answer: unknown): number | null {
  if (!answer || typeof answer !== "object") return null;
  const fields = answer as Record<string, unknown>;
  const candidate = fields.noul ?? fields.probability ?? fields.p ?? (fields.probabilities as Record<string, unknown> | undefined)?.true;
  const value = typeof candidate === "number" ? candidate : Number(candidate);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export async function askJeeves(
  apiKey: string | undefined,
  state: Record<string, unknown>,
  questions: Map<string, YesNoQuestion>,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<JeevesResult> {
  const startedAt = now();
  const failed = (error: string): JeevesResult => ({ ok: false, error, latencyMs: now() - startedAt });
  if (!apiKey) return failed("JEEVES_API_KEY is not set");
  if (!questions.size) return { ok: true, probabilities: new Map(), latencyMs: 0 };
  const body = {
    model: JEEVES.model,
    state,
    questions: Object.fromEntries([...questions].map(([id, question]) => [id, { type: "noul", ...question }])),
  };
  let response: Response;
  try {
    response = await fetchImpl(JEEVES.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JEEVES.timeoutMs),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.name === "TimeoutError" ? "timed out" : error.message : String(error));
  }
  if (!response.ok) return failed(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  const payload = (await response.json().catch(() => null)) as { answers?: Record<string, unknown> } | null;
  const probabilities = new Map<string, number>();
  for (const id of questions.keys()) {
    const probability = probabilityOf(payload?.answers?.[id]);
    if (probability === null) return failed(`no answer for ${id}`);
    probabilities.set(id, probability);
  }
  return { ok: true, probabilities, latencyMs: now() - startedAt };
}
