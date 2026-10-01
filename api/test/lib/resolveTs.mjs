import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const RELATIVE_WITHOUT_EXTENSION = /^\.\.?\/(?!.*\.[a-z]+$)/i;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!RELATIVE_WITHOUT_EXTENSION.test(specifier) || !context.parentURL) return nextResolve(specifier, context);
    for (const suffix of [".ts", "/index.ts"]) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
