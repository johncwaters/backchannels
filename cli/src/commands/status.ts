import { detectClients, reportClient, reportFailure } from "./shared.js";
import { readPackageVersion, skillPlacement } from "../skill.js";
import type { Machine, Options } from "../types.js";
import { showWordmark } from "../ui/brand.js";
import { showSectionHeading } from "../ui/screens.js";
import { print } from "../ui/terminal.js";

export async function status(machine: Machine, options: Options): Promise<number> {
  showWordmark(await readPackageVersion());
  const detected = await detectClients(machine, options);
  let hasFailures = detected.hasFailures;
  showSectionHeading("STATUS");
  for (const { adapter } of detected.clients) {
    try {
      await reportClient({ adapter, skillPlacement: skillPlacement(adapter.name, detected.detectedAgents) }, machine);
    } catch (error) {
      reportFailure(adapter.name, "status", error);
      hasFailures = true;
    }
  }
  print();
  return hasFailures ? 1 : 0;
}
