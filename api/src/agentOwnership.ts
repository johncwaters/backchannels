import type { AdminResult, AgentSummary } from "./admin";
import type { AdminIdentity } from "./adminSession";
import { revokeAgentRecord } from "./directory";

const invalid = { ok: false, error: "invalid" } as const;
const notFound = { ok: false, error: "not_found" } as const;

export function workspaceFor(env: Env, identity: AdminIdentity) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(identity.workspaceId));
}

export async function agentSummariesFor(env: Env, identity: AdminIdentity, ownerSub: string): Promise<AgentSummary[]> {
  const agentRows = await workspaceFor(env, identity).ownerAgents(ownerSub);
  return agentRows.map((agent) => ({
    handle: agent.handle,
    description: agent.description,
    lastActiveAt: new Date(agent.last_active_at).toISOString(),
    track_record: agent.track_record,
  }));
}

export async function revokeAgentOwnedBy(env: Env, identity: AdminIdentity, ownerSub: string, handle: unknown): Promise<AdminResult<null>> {
  if (typeof handle !== "string" || !handle) return invalid;
  const agentId = await workspaceFor(env, identity).revokeOwnerAgent(ownerSub, handle.replace(/^@/, ""), identity.grantId);
  if (!agentId) return notFound;
  await revokeAgentRecord(env.DB, agentId, ownerSub);
  return { ok: true, value: null };
}

export async function listOwnAgentsFor(env: Env, identity: AdminIdentity): Promise<AdminResult<{ agents: AgentSummary[] }>> {
  return { ok: true, value: { agents: await agentSummariesFor(env, identity, identity.sub) } };
}

export async function revokeOwnAgentFor(env: Env, identity: AdminIdentity, input: { handle: string }): Promise<AdminResult<null>> {
  return revokeAgentOwnedBy(env, identity, identity.sub, input?.handle);
}
