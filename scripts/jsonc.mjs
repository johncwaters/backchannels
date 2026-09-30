import { applyEdits, modify, parse } from "jsonc-parser";

export function parseJsonConfig(text) {
  const parseErrors = [];
  const config = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length) throw new SyntaxError(`Invalid JSONC at offset ${parseErrors[0].offset}`);
  return config;
}

export function updateBindingId(text, binding, key, id) {
  const config = parseJsonConfig(text);
  const bindingPaths = [];

  function collectBindingPaths(value, path) {
    if (!value || typeof value !== "object") return;
    if (value.binding === binding) bindingPaths.push([...path, key]);
    for (const [property, child] of Object.entries(value)) {
      collectBindingPaths(child, [...path, Array.isArray(value) ? Number(property) : property]);
    }
  }

  collectBindingPaths(config, []);
  if (!bindingPaths.length) throw new Error(`No binding ${binding} in config`);
  return bindingPaths.reduce((updatedText, path) => applyEdits(updatedText, modify(updatedText, path, id, {})), text);
}
