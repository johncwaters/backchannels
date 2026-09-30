import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "--short", "HEAD");
const hasUncommittedChanges = git("status", "--porcelain").length > 0;
process.stdout.write(hasUncommittedChanges ? `${commit}-dirty` : commit);
