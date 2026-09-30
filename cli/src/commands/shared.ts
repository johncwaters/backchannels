import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { claude } from "../clients/claude.js";
import { codex } from "../clients/codex.js";
import { cursor } from "../clients/cursor.js";
import { AGENT_NAMES, MCP_URL } from "../constants.js";
import { installSkillActions, readInstalledSkillVersion, skillPlacement, type SkillPlacement } from "../skill.js";
import { installSessionHookActions, readSessionHookInstalled } from "../session-hook.js";
import { run } from "../machine.js";
import type { Action, AgentName, ClientAdapter, ClientState, CommandAction, Machine, Options, SignIn } from "../types.js";

const adapterByName: Record<AgentName, ClientAdapter> = { claude, codex, cursor };

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
  const clients: DetectedClient[] = [];
  const detectedAgents: AgentName[] = [];
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
        console.log(`${name}: not detected`);
        continue;
      }
      detectedAgents.push(name);
      const registration = await adapter.readRegistration(machine);
      const signIn = await adapter.readSignIn(machine);
      clients.push({ adapter, state: { detection, registration, signIn } });
    } catch (error) {
      reportFailure(name, "detect/read", error);
      hasFailures = true;
    }
  }
  return { clients, detectedAgents, hasFailures };
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

export async function prepare(machine: Machine, options: Options) {
  const detected = await detectClients(machine, options);
  const clients: PreparedClient[] = [];
  let hasFailures = detected.hasFailures;
  for (const { adapter, state } of detected.clients) {
    const placement = skillPlacement(adapter.name, detected.detectedAgents);
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
  return { clients, hasFailures };
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

export function printActions(clients: PreparedClient[]): void {
  for (const client of clients) {
    console.log(`${client.adapter.name}:`);
    if (client.actions.length === 0) console.log("  already installed; no changes planned");
    for (const action of client.actions) {
      if (action.kind === "command") {
        console.log(`  ${action.argv.join(" ")}${action.interactive ? " (interactive)" : ""}`);
        continue;
      }
      console.log(`  ${action.path}: ${action.describe}`);
    }
    for (const notice of client.notices) console.log(`  ${notice}`);
  }
}

export async function confirm(machine: Machine, options: Options): Promise<boolean> {
  if (options.dryRun || options.yes) return true;
  if (!machine.isInteractive) {
    console.error("Refusing to change files without a TTY. Pass --yes for a scripted install, or --dry-run to inspect the plan.");
    return false;
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question("Continue? [Y/n] ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
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
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`${agent}: ${step} failed: ${reason}`);
}

export function signInDescription(signIn: SignIn): string {
  if (signIn === "signed-in") return "signed in";
  if (signIn === "signed-out") return "not signed in";
  return "sign-in unknown";
}

export async function reportClient(client: ReportableClient, machine: Machine, installOutcome?: ApplyOutcome): Promise<void> {
  const registration = await client.adapter.verifyRegistration(machine);
  const reportedSignIn = await client.adapter.readSignIn(machine);
  const signIn = installOutcome?.hasSignedIn && reportedSignIn === "unknown" ? "signed-in" : reportedSignIn;
  const version = await readInstalledSkillVersion(client.skillPlacement);
  if (installOutcome && client.skillPlacement.installPath && !version) throw new Error("Installed skill version could not be read.");
  if (installOutcome?.hasSignedIn && signIn !== "signed-in") throw new Error("Sign-in did not finish; run the client's login command.");
  const registrationDescription = registration.url === MCP_URL ? "registered" : "not registered";
  const sessionHookDescription = await describeSessionHook(client.adapter.name, client.skillPlacement);
  console.log(`${client.adapter.name}: ${registrationDescription}, ${signInDescription(signIn)}, skill version ${version ?? "not installed"}${sessionHookDescription}`);
}

async function describeSessionHook(agent: AgentName, placement: SkillPlacement): Promise<string> {
  try {
    const isSessionHookInstalled = await readSessionHookInstalled(agent, placement);
    if (isSessionHookInstalled === undefined) return "";
    return `, session hook ${isSessionHookInstalled ? "installed" : "not installed"}`;
  } catch {
    return ", session hook unreadable";
  }
}

async function trySignIn(agent: AgentName, action: CommandAction): Promise<boolean> {
  try {
    await executeAction(action);
    return true;
  } catch (error) {
    reportFailure(agent, action.argv.join(" "), error);
    return false;
  }
}

export async function applyClient(client: PreparedClient, machine: Machine): Promise<ApplyOutcome> {
  let hasSignedIn = false;
  let hasSignInFailure = false;
  let step = "execute";
  try {
    for (const action of client.actions) {
      step = action.kind === "command" ? action.argv.join(" ") : action.path;
      if (!isSignInAction(action)) {
        await executeAction(action);
        continue;
      }
      const isSignedIn = await trySignIn(client.adapter.name, action);
      hasSignedIn ||= isSignedIn;
      hasSignInFailure ||= !isSignedIn;
    }
    step = "verify registration";
    const registration = await client.adapter.verifyRegistration(machine);
    if (registration.url !== MCP_URL) throw new Error("backchannels URL does not match; follow the printed manual commands.");
    return { isRegistered: true, hasSignedIn, hasSignInFailure };
  } catch (error) {
    reportFailure(client.adapter.name, step, error);
    return { isRegistered: false, hasSignedIn, hasSignInFailure };
  }
}
