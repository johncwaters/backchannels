import { fileURLToPath } from "node:url";
import { fileUpdateAction, readText } from "./config-file.js";
import { homePath } from "./machine.js";
import type { Action, AgentName } from "./types.js";

const NEW_SKILL_FILE_MODE = 0o644;

export interface SkillPlacement {
  readPaths: string[];
  installPath?: string;
}

export function skillPlacement(agent: AgentName, detectedAgents: AgentName[]): SkillPlacement {
  const claudeSkillPath = homePath(".claude", "skills", "backchannels", "SKILL.md");
  const sharedSkillPath = homePath(".agents", "skills", "backchannels", "SKILL.md");
  if (agent === "claude") return { readPaths: [claudeSkillPath], installPath: claudeSkillPath };
  if (agent === "codex") return { readPaths: [sharedSkillPath], installPath: sharedSkillPath };
  const hasAgentWithOwnSkill = detectedAgents.includes("claude") || detectedAgents.includes("codex");
  return { readPaths: [sharedSkillPath, claudeSkillPath], installPath: hasAgentWithOwnSkill ? undefined : sharedSkillPath };
}

export async function readSkillVersion(path: string): Promise<string | undefined> {
  const frontmatter = (await readText(path)).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return frontmatter?.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
}

export async function readInstalledSkillVersion(placement: SkillPlacement): Promise<string | undefined> {
  for (const path of placement.readPaths) {
    const version = await readSkillVersion(path);
    if (version) return version;
  }
  return undefined;
}

export async function installSkillActions(placement: SkillPlacement): Promise<Action[]> {
  if (!placement.installPath) return [];
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageVersion: unknown = JSON.parse(await readText(packagePath)).version;
  if (typeof packageVersion !== "string") throw new Error("Package version must be a string.");
  const template = await readText(fileURLToPath(new URL("../skill/SKILL.md", import.meta.url)));
  if (!template.startsWith("---\n")) throw new Error("Skill frontmatter is missing.");
  const content = template.replace("---\n", `---\nversion: ${JSON.stringify(packageVersion)}\n`);
  return fileUpdateAction(placement.installPath, () => content, `install backchannels skill version ${packageVersion}`, NEW_SKILL_FILE_MODE);
}
