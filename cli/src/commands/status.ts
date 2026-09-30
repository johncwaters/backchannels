import { detectClients, reportClient, reportFailure } from "./shared.js";
import { skillPlacement } from "../skill.js";
import type { Machine, Options } from "../types.js";

export async function status(machine: Machine, options: Options): Promise<number> {
  const detected = await detectClients(machine, options);
  let hasFailures = detected.hasFailures;
  for (const { adapter } of detected.clients) {
    try {
      await reportClient({ adapter, skillPlacement: skillPlacement(adapter.name, detected.detectedAgents) }, machine);
    } catch (error) {
      reportFailure(adapter.name, "status", error);
      hasFailures = true;
    }
  }
  return hasFailures ? 1 : 0;
}
