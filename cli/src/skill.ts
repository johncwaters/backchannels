import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileUpdateAction, readText } from "./config-file.js";
import { homePath } from "./machine.js";
import type { Action, AgentName } from "./types.js";

const NEW_SKILL_FILE_MODE = 0o644;
export const SKILL_DIRECTORY_NAME = "backchannels";
export const SESSION_START_FILE = "session-start.txt";

export interface SkillPlacement {
  readPaths: string[];
  installPath?: string;
}

export function sessionStartTextPath(skillPath: string): string {
  return join(dirname(skillPath), SESSION_START_FILE);
}

export function skillPlacement(agent: AgentName, detectedAgents: AgentName[]): SkillPlacement {
  const claudeSkillPath = homePath(".claude", "skills", SKILL_DIRECTORY_NAME, "SKILL.md");
  const sharedSkillPath = homePath(".agents", "skills", SKILL_DIRECTORY_NAME, "SKILL.md");
  if (agent === "claude") return { readPaths: [claudeSkillPath], installPath: claudeSkillPath };
  if (agent === "codex") return { readPaths: [sharedSkillPath], installPath: sharedSkillPath };
  const hasAgentWithOwnSkill = detectedAgents.includes("claude") || detectedAgents.includes("codex");
  return { readPaths: [sharedSkillPath, claudeSkillPath], installPath: hasAgentWithOwnSkill ? undefined : sharedSkillPath };
}

export async function readSkillVersion(path: string): Promise<string | undefined> {
  const frontmatter = (await readText(path)).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  let isInMetadata = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const topLevelVersion = line.match(/^version:[ \t]*["']?([^\s"']+)["']?[ \t]*$/)?.[1];
    if (topLevelVersion) return topLevelVersion;
    if (/^\S/.test(line)) isInMetadata = /^metadata:[ \t]*$/.test(line);
    if (!isInMetadata) continue;
    const metadataVersion = line.match(/^[ \t]+version:[ \t]*["']?([^\s"']+)["']?[ \t]*$/)?.[1];
    if (metadataVersion) return metadataVersion;
  }
  return undefined;
}

export async function readInstalledSkillVersion(placement: SkillPlacement): Promise<string | undefined> {
  for (const path of placement.readPaths) {
    const version = await readSkillVersion(path);
    if (version) return version;
  }
  return undefined;
}

async function readPackageVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageVersion: unknown = JSON.parse(await readText(packagePath)).version;
  if (typeof packageVersion !== "string") throw new Error("Package version must be a string.");
  return packageVersion;
}

async function readVersionedTemplate(fileName: string, packageVersion: string): Promise<string> {
  const template = await readText(fileURLToPath(new URL(`../skill/${fileName}`, import.meta.url)));
  if (!template.includes("{{SKILL_VERSION}}")) throw new Error(`${fileName} is missing the {{SKILL_VERSION}} placeholder.`);
  return template.replaceAll("{{SKILL_VERSION}}", packageVersion);
}

export async function installSkillActions(placement: SkillPlacement): Promise<Action[]> {
  if (!placement.installPath) return [];
  const packageVersion = await readPackageVersion();
  const skill = await readVersionedTemplate("SKILL.md", packageVersion);
  if (!skill.startsWith("---\n")) throw new Error("Skill frontmatter is missing.");
  const skillContent = skill.replace("---\n", `---\nmetadata:\n  version: ${JSON.stringify(packageVersion)}\n`);
  const sessionStartContent = await readVersionedTemplate(SESSION_START_FILE, packageVersion);
  return [
    ...await fileUpdateAction(placement.installPath, () => skillContent, `install backchannels skill version ${packageVersion}`, NEW_SKILL_FILE_MODE),
    ...await fileUpdateAction(sessionStartTextPath(placement.installPath), () => sessionStartContent, `install backchannels session-start text version ${packageVersion}`, NEW_SKILL_FILE_MODE),
  ];
}
