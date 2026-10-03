import { createClaudeAdapter } from "../clients/claude.js";
import { codex } from "../clients/codex.js";
import { cursor } from "../clients/cursor.js";
import { AGENT_NAMES, MCP_URL } from "../constants.js";
import { installSkillActions, readInstalledSkillVersion, skillPlacement, type SkillPlacement } from "../skill.js";
import { installSessionHookActions, readSessionHookInstalled } from "../session-hook.js";
import { run } from "../machine.js";
import type { Action, AgentName, ClientAdapter, ClientState, CommandAction, Machine, Options } from "../types.js";
import { showClientHeader, showClientHealth, showFailure, showHandOff, type ClientHealth } from "../ui/screens.js";
import { marks, runTask } from "../ui/task.js";
import { print } from "../ui/terminal.js";
import { paint, tones } from "../ui/style.js";

export interface DetectedClient {
  adapter: ClientAdapter;
  state: ClientState;
}

export interface ReportableClient {
  adapter: ClientAdapter;
  skillPlacement: SkillPlacement;
}

export interface PreparedClient extends DetectedClient, ReportableClient {
  actions: Action[];
  notices: string[];
}

export interface ApplyOutcome {
  isRegistered: boolean;
  hasSignedIn: boolean;
  hasSignInFailure: boolean;
}

export async function detectClients(machine: Machine, options: Options) {
  const adapterByName: Record<AgentName, ClientAdapter> = { claude: createClaudeAdapter(), codex, cursor };
  const clients: DetectedClient[] = [];
  const detectedAgents: AgentName[] = [];
  const missingAgents: AgentName[] = [];
  let hasFailures = false;
  for (const name of AGENT_NAMES) {
    const adapter = adapterByName[name];
    if (options.agent && options.agent !== name) {
      if (await isPresentOrReport(adapter, machine)) detectedAgents.push(name);
      continue;
    }
    try {
      const detection = await adapter.detect(machine);
      if (!detection.present) {
        missingAgents.push(name);
        continue;
      }
      detectedAgents.push(name);
      const registration = await adapter.readRegistration(machine, detection);
      const signIn = await adapter.readSignIn(machine, detection);
      clients.push({ adapter, state: { detection, registration, signIn } });
    } catch (error) {
      reportFailure(name, "detect/read", error);
      hasFailures = true;
    }
  }
  return { clients, detectedAgents, missingAgents, hasFailures };
}

async function isPresentOrReport(adapter: ClientAdapter, machine: Machine): Promise<boolean> {
  try {
    return await adapter.isPresent(machine);
  } catch (error) {
    reportFailure(adapter.name, "detect", error);
    return false;
  }
}

function isSignInAction(action: Action): action is CommandAction {
  return action.kind === "command" && action.signsIn === true;
}

export type DetectionResult = Awaited<ReturnType<typeof detectClients>>;

export async function planClients(machine: Machine, detected: DetectionResult, selectedAgents?: AgentName[]) {
  const chosenClients = selectedAgents ? detected.clients.filter(client => selectedAgents.includes(client.adapter.name)) : detected.clients;
  const placementAgents = selectedAgents ?? detected.detectedAgents;
  const clients: PreparedClient[] = [];
  let hasFailures = detected.hasFailures;
  for (const { adapter, state } of chosenClients) {
    const placement = skillPlacement(adapter.name, placementAgents);
    try {
      const adapterActions = await adapter.installActions(machine, state);
      const skillActions = await installSkillActions(placement);
      const hookActions = await planSessionHookOrReport(adapter.name, placement);
      hasFailures ||= hookActions === undefined;
      const actions = [...adapterActions.filter(action => !isSignInAction(action)), ...skillActions, ...hookActions ?? [], ...adapterActions.filter(isSignInAction)];
      const notices = [...adapter.notices(machine, state), ...sessionHookNotices(adapter.name, hookActions ?? [])];
      clients.push({ adapter, state, skillPlacement: placement, actions, notices });
    } catch (error) {
      reportFailure(adapter.name, "plan", error);
      hasFailures = true;
    }
  }
  return { clients, missingAgents: detected.missingAgents, hasFailures };
}

async function planSessionHookOrReport(agent: AgentName, placement: SkillPlacement): Promise<Action[] | undefined> {
  try {
    return await installSessionHookActions(agent, placement);
  } catch (error) {
    reportFailure(agent, "plan session hook", error);
    return undefined;
  }
}

function sessionHookNotices(agent: AgentName, hookActions: Action[]): string[] {
  if (agent !== "codex" || hookActions.length === 0) return [];
  return ["Codex runs a new hook only after you trust it: open /hooks in Codex once and trust the backchannels SessionStart hook."];
}

export async function executeAction(action: Action): Promise<void> {
  if (action.kind === "file") {
    await action.apply();
    return;
  }
  const output = await run(action.argv, action.interactive);
  if (output.code === 0 || action.isToleratedFailure?.(output)) return;
  throw new Error([`exit ${output.code}.`, action.failureMessage].filter(Boolean).join(" "));
}

export function reportFailure(agent: AgentName, step: string, error: unknown): void {
  showFailure(agent, step, error instanceof Error ? error.message : String(error));
}

export async function reportClient(client: ReportableClient, machine: Machine, installOutcome?: ApplyOutcome): Promise<void> {
  const registration = await client.adapter.verifyRegistration(machine);
  const reportedSignIn = await client.adapter.readSignIn(machine);
  const signIn = installOutcome?.hasSignedIn && reportedSignIn === "unknown" ? "signed-in" : reportedSignIn;
  const version = await readInstalledSkillVersion(client.skillPlacement);
  if (installOutcome && client.skillPlacement.installPath && !version) throw new Error("Installed skill version could not be read.");
  if (installOutcome?.hasSignedIn && signIn !== "signed-in") throw new Error("Sign-in did not finish; run the client's login command.");
  const health: ClientHealth = {
    agent: client.adapter.name,
    isRegistered: registration.url === MCP_URL,
    signIn,
    skillVersion: version,
    sessionHook: await readSessionHookState(client.adapter.name, client.skillPlacement),
  };
  showClientHealth(health);
}

async function readSessionHookState(agent: AgentName, placement: SkillPlacement): Promise<ClientHealth["sessionHook"]> {
  try {
    const isSessionHookInstalled = await readSessionHookInstalled(agent, placement);
    if (isSessionHookInstalled === undefined) return "not-applicable";
    return isSessionHookInstalled ? "installed" : "missing";
  } catch {
    return "unreadable";
  }
}

async function trySignIn(agent: AgentName, action: CommandAction): Promise<boolean> {
  showHandOff(action.summary);
  try {
    await executeAction(action);
    print(`    ${marks.done()} ${paint(tones.text, action.summary)}`);
    return true;
  } catch (error) {
    reportFailure(agent, action.argv.join(" "), error);
    return false;
  }
}

async function verifyConnection(client: PreparedClient, machine: Machine): Promise<void> {
  const registration = await client.adapter.verifyRegistration(machine);
  if (registration.url !== MCP_URL) throw new Error("backchannels URL does not match; follow the printed manual commands.");
}

export async function applyClient(client: PreparedClient, machine: Machine): Promise<ApplyOutcome> {
  let hasSignedIn = false;
  let hasSignInFailure = false;
  let step = "execute";
  showClientHeader(client.adapter.name);
  try {
    for (const action of client.actions) {
      step = action.kind === "command" ? action.argv.join(" ") : action.path;
      client.adapter.clearReadCache?.();
      if (!isSignInAction(action)) {
        await runTask(() => executeAction(action), { running: action.summary, done: () => paint(tones.text, action.summary), indent: "    " });
        continue;
      }
      const isSignedIn = await trySignIn(client.adapter.name, action);
      hasSignedIn ||= isSignedIn;
      hasSignInFailure ||= !isSignedIn;
    }
    step = "verify registration";
    await runTask(() => verifyConnection(client, machine), { running: "check the connection", done: () => paint(tones.text, "check the connection"), indent: "    " });
    return { isRegistered: true, hasSignedIn, hasSignInFailure };
  } catch (error) {
    reportFailure(client.adapter.name, step, error);
    return { isRegistered: false, hasSignedIn, hasSignInFailure };
  }
}
