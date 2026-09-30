import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function deploymentRefusal({ workingTreeStatus, head, originMain }) {
  if (workingTreeStatus.trim()) return "Deploy requires a clean working tree.";
  if (!head || !originMain || head !== originMain) return "Deploy requires HEAD to equal origin/main.";
  return undefined;
}

export function assertDeploymentAllowed(repositoryPath = process.cwd()) {
  const git = (...argumentsList) => execFileSync("git", argumentsList, { cwd: repositoryPath, encoding: "utf8" }).trim();
  git("fetch", "--quiet", "origin", "main");
  const refusal = deploymentRefusal({
    workingTreeStatus: git("status", "--porcelain", "--untracked-files=all"),
    head: git("rev-parse", "HEAD"),
    originMain: git("rev-parse", "--verify", "refs/remotes/origin/main"),
  });
  if (refusal) throw new Error(refusal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertDeploymentAllowed();
}
