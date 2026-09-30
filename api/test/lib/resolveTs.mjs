import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const RELATIVE_WITHOUT_EXTENSION = /^\.\.?\/(?!.*\.[a-z]+$)/i;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!RELATIVE_WITHOUT_EXTENSION.test(specifier) || !context.parentURL) return nextResolve(specifier, context);
    const typescriptSibling = new URL(`${specifier}.ts`, context.parentURL);
    if (!existsSync(fileURLToPath(typescriptSibling))) return nextResolve(specifier, context);
    return nextResolve(typescriptSibling.href, context);
  },
});
