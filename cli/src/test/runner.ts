import { main } from "../main.js";
import type { Machine } from "../types.js";
const machine = JSON.parse(process.argv[2]) as Machine;
process.exitCode = await main(process.argv.slice(3), machine);
