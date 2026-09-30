import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createMachine } from "./machine.js";
import { install } from "./commands/install.js";
import { status } from "./commands/status.js";
import { wait } from "./commands/wait.js";
import { AGENT_NAMES } from "./constants.js";
import type { AgentName, Machine, Options } from "./types.js";

const COMMANDS = ["install", "status", "wait"];
const USAGE = `Usage: backchannels [${COMMANDS.join("|")}] [--yes] [--dry-run] [--agent ${AGENT_NAMES.join("|")}]\n       BACKCHANNELS_TICKET=<ticket> backchannels wait <url>`;

function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

export async function main(arguments_ = process.argv.slice(2), machine: Machine = createMachine()): Promise<number> {
  let command: string;
  let options: Options;
  let waitArguments: [string, string] | undefined;
  try {
    const parsed = parseArgs({ args: arguments_, allowPositionals: true, options: {
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      agent: { type: "string" },
      help: { type: "boolean", default: false },
    } });
    if (parsed.values.help) {
      console.log(USAGE);
      return 0;
    }
    if (parsed.positionals[0] !== "wait" && parsed.positionals.length > 1) throw new Error("Expected at most one subcommand.");
    command = parsed.positionals[0] ?? "install";
    if (!COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
    if (command === "wait") {
      const [, url] = parsed.positionals;
      const ticket = process.env.BACKCHANNELS_TICKET;
      if (parsed.positionals.length !== 2 || !url) throw new Error("Expected wait <url>.");
      if (!ticket) throw new Error("Expected the ticket in BACKCHANNELS_TICKET.");
      waitArguments = [url, ticket];
    }
    const agent = parsed.values.agent;
    if (agent !== undefined && !isAgentName(agent)) throw new Error(`--agent must be one of: ${AGENT_NAMES.join(", ")}.`);
    options = { yes: parsed.values.yes, dryRun: parsed.values["dry-run"], agent };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  try {
    if (waitArguments) return await wait(...waitArguments);
    if (command === "status") return await status(machine, options);
    return await install(machine, options);
  } catch (error) {
    console.error(`backchannels failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
