import { canAskForGuidelines, runGuidelinesStep } from "./guidelines.js";
import { applyClient, detectClients, planClients, reportClient, reportFailure, type ApplyOutcome, type DetectionResult, type PreparedClient } from "./shared.js";
import { MCP_URL } from "../constants.js";
import { readPackageVersion } from "../skill.js";
import type { AgentName, Machine, Options } from "../types.js";
import { showIntro } from "../ui/brand.js";
import { agentLabel, agentList, agentTone, askToContinue, showDryRunNote, showNextSteps, showPitch, showPlan, showProblem, showSectionHeading } from "../ui/screens.js";
import { paint, tones } from "../ui/style.js";
import { canSelect, selectMany } from "../ui/select.js";
import { runTask } from "../ui/task.js";
import { print } from "../ui/terminal.js";

const NO_TTY_MESSAGE = "Refusing to change files without a TTY. Pass --yes for a scripted install, or --dry-run to inspect the plan.";
const NO_AGENTS_MESSAGE = "No supported agents found. backchannels works with Claude Code, Codex and Cursor.";

async function confirm(machine: Machine, options: Options, clients: PreparedClient[]): Promise<boolean> {
  if (options.yes) return true;
  if (!machine.isInteractive) {
    showProblem(NO_TTY_MESSAGE);
    return false;
  }
  return askToContinue(clients.map(client => client.adapter.name));
}

function foundAgentsLabel(detected: DetectionResult): string {
  if (detected.clients.length === 0) return paint(tones.text, "No supported agents found");
  return `${paint(tones.text, "Found")} ${paint(tones.accent, agentList(detected.clients.map(client => client.adapter.name)))}`;
}

async function chooseAgents(options: Options, detected: DetectionResult): Promise<AgentName[] | undefined> {
  if (options.yes || options.agent || detected.clients.length < 2 || !canSelect()) return undefined;
  print();
  return selectMany("Which agents should use backchannels?", detected.clients.map(({ adapter, state }) => ({
    value: adapter.name,
    label: agentLabel(adapter.name),
    tone: agentTone(adapter.name),
    hint: state.registration.url === MCP_URL ? "connected" : undefined,
  })));
}

export async function install(machine: Machine, options: Options): Promise<number> {
  await showIntro(await readPackageVersion());
  await showPitch();
  const detected = await runTask(() => detectClients(machine, options), { running: "Looking for your agents", done: foundAgentsLabel });
  const selectedAgents = await chooseAgents(options, detected);
  const prepared = await planClients(machine, detected, selectedAgents);
  print();
  await showPlan(prepared.clients.map(client => ({ agent: client.adapter.name, actions: client.actions, notices: client.notices })), prepared.missingAgents);
  if (options.dryRun) {
    showDryRunNote();
    return prepared.hasFailures ? 1 : 0;
  }
  if (prepared.clients.length === 0) {
    showProblem(NO_AGENTS_MESSAGE);
    return 1;
  }
  const hasChanges = prepared.clients.some(client => client.actions.length > 0);
  if (hasChanges && !await confirm(machine, options, prepared.clients)) {
    print(`  ${paint(tones.dim, "Nothing was changed.")}`);
    return 1;
  }
  let hasFailures = prepared.hasFailures;
  if (canAskForGuidelines(machine, options) && !await runGuidelinesStep()) hasFailures = true;
  showSectionHeading(hasChanges ? "SETTING UP" : "CHECKING");
  const registeredClients: { client: PreparedClient; outcome: ApplyOutcome }[] = [];
  for (const client of prepared.clients) {
    const outcome = await applyClient(client, machine);
    if (outcome.hasSignInFailure || !outcome.isRegistered) hasFailures = true;
    if (outcome.isRegistered) registeredClients.push({ client, outcome });
  }
  print();
  showSectionHeading("STATUS");
  for (const { client, outcome } of registeredClients) {
    try {
      await reportClient(client, machine, outcome);
    } catch (error) {
      reportFailure(client.adapter.name, "verify sign-in/skill", error);
      hasFailures = true;
    }
  }
  await showNextSteps(hasFailures);
  return hasFailures ? 1 : 0;
}
