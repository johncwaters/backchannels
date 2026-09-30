import { applyClient, confirm, printActions, prepare, reportClient, reportFailure } from "./shared.js";
import type { Machine, Options } from "../types.js";

export async function install(machine: Machine, options: Options): Promise<number> {
  const prepared = await prepare(machine, options);
  printActions(prepared.clients);
  if (options.dryRun) return prepared.hasFailures ? 1 : 0;
  if (prepared.clients.length === 0) {
    console.error("No supported agents detected.");
    return 1;
  }
  if (!await confirm(machine, options)) return 1;
  let hasFailures = prepared.hasFailures;
  for (const client of prepared.clients) {
    const outcome = await applyClient(client, machine);
    if (outcome.hasSignInFailure) hasFailures = true;
    if (!outcome.isRegistered) {
      hasFailures = true;
      continue;
    }
    try {
      await reportClient(client, machine, outcome);
    } catch (error) {
      reportFailure(client.adapter.name, "verify sign-in/skill", error);
      hasFailures = true;
    }
  }
  return hasFailures ? 1 : 0;
}
