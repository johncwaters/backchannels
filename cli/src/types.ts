import type { AGENT_NAMES } from "./constants.js";
import type { CommandOutput } from "./machine.js";

export type AgentName = (typeof AGENT_NAMES)[number];

export interface Machine {
  isInteractive: boolean;
  canOpenBrowser: boolean;
}

export interface Detection {
  present: boolean;
  hasCli: boolean;
  supportsCommands: boolean;
}

export type SignIn = "signed-in" | "signed-out" | "unknown";

export interface ClientState {
  detection: Detection;
  registration: { url?: string };
  signIn: SignIn;
}

export interface CommandAction {
  kind: "command";
  argv: string[];
  interactive: boolean;
  signsIn?: boolean;
  isToleratedFailure?: (output: CommandOutput) => boolean;
  failureMessage?: string;
}

export interface FileAction {
  kind: "file";
  path: string;
  describe: string;
  apply: () => Promise<void>;
}

export type Action = CommandAction | FileAction;

export interface ClientAdapter {
  name: AgentName;
  clearReadCache?(): void;
  isPresent(machine: Machine): Promise<boolean>;
  detect(machine: Machine): Promise<Detection>;
  readRegistration(machine: Machine, detection?: Detection): Promise<{ url?: string }>;
  readSignIn(machine: Machine, detection?: Detection): Promise<SignIn>;
  installActions(machine: Machine, state: ClientState): Promise<Action[]>;
  verifyRegistration(machine: Machine): Promise<{ url?: string }>;
  notices(machine: Machine, state: ClientState): string[];
}

export interface Options {
  yes: boolean;
  dryRun: boolean;
  agent?: AgentName;
}
