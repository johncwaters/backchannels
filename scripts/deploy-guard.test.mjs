import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertDeploymentAllowed, deploymentRefusal } from "./deploy-guard.mjs";

const deployableState = { workingTreeStatus: "", head: "published", originMain: "published" };

test("allows a clean tree at origin/main on any branch", () => {
  assert.equal(deploymentRefusal(deployableState), undefined);
});

for (const workingTreeStatus of [" M tracked", "M  staged", "?? untracked"]) {
  test(`refuses working tree status ${workingTreeStatus}`, () => {
    assert.match(deploymentRefusal({ ...deployableState, workingTreeStatus }), /clean working tree/);
  });
}

for (const head of ["ahead", "behind", "diverged", ""]) {
  test(`refuses HEAD ${head || "missing"}`, () => {
    assert.match(deploymentRefusal({ ...deployableState, head }), /HEAD to equal origin\/main/);
  });
}

test("refuses a missing origin/main", () => {
  assert.match(deploymentRefusal({ ...deployableState, originMain: "" }), /HEAD to equal origin\/main/);
});

test("reads Git state on any branch and refuses untracked files and unpublished commits", (context) => {
  const scratchPath = mkdtempSync(join(tmpdir(), "backchannels-deploy-"));
  context.after(() => rmSync(scratchPath, { recursive: true, force: true }));
  const originPath = join(scratchPath, "origin.git");
  const repositoryPath = join(scratchPath, "checkout");
  const gitIn = (cwd, ...argumentsList) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Deploy Test", "-c", "user.email=deploy@example.com", ...argumentsList], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const git = (...argumentsList) => gitIn(repositoryPath, ...argumentsList);
  gitIn(scratchPath, "init", "--bare", "--initial-branch=main", originPath);
  gitIn(scratchPath, "init", "--initial-branch=main", repositoryPath);
  git("remote", "add", "origin", originPath);
  git("commit", "--allow-empty", "-m", "initial");
  git("push", "--quiet", "origin", "main");
  assert.doesNotThrow(() => assertDeploymentAllowed(repositoryPath));
  git("checkout", "--quiet", "-b", "feature");
  assert.doesNotThrow(() => assertDeploymentAllowed(repositoryPath));
  writeFileSync(join(repositoryPath, "untracked"), "pending");
  assert.throws(() => assertDeploymentAllowed(repositoryPath), /clean working tree/);
  git("add", "untracked");
  assert.throws(() => assertDeploymentAllowed(repositoryPath), /clean working tree/);
  git("commit", "-m", "unpublished");
  assert.throws(() => assertDeploymentAllowed(repositoryPath), /HEAD to equal origin\/main/);
});
