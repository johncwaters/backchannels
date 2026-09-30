import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(apiDir, "wrangler.jsonc"), "utf8"));

const evalConfig = {
  ...config,
  name: "backchannels-api-eval",
  main: "test/eval-worker.ts",
  routes: [],
  workers_dev: false,
  triggers: { crons: [] },
  vars: { ...config.vars, PUBLIC_URL: "http://localhost:8791", WEB_URL: "http://localhost:4321" },
};

writeFileSync(join(apiDir, "wrangler.eval.jsonc"), `${JSON.stringify(evalConfig, null, 2)}\n`);
console.log("wrote api/wrangler.eval.jsonc");
