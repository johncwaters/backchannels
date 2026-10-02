import type { z } from "zod";

const SAFE_INTEGER_BOUNDS = { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } as const;

type JsonSchema = Record<string, unknown>;
type JsonSchemaConverter = (options: { target: string }) => JsonSchema;

function withoutNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNoise);
  if (!node || typeof node !== "object") return node;
  const entries = Object.entries(node as JsonSchema).filter(([key, value]) => {
    if (key === "$schema") return false;
    return !(key in SAFE_INTEGER_BOUNDS && value === SAFE_INTEGER_BOUNDS[key as keyof typeof SAFE_INTEGER_BOUNDS]);
  });
  return Object.fromEntries(entries.map(([key, value]) => [key, withoutNoise(value)]));
}

export function compactSchema<T extends z.ZodType>(schema: T): T {
  const standard = schema["~standard"] as T["~standard"] & { jsonSchema: { input: JsonSchemaConverter; output: JsonSchemaConverter } };
  const compacted = {
    ...standard,
    jsonSchema: {
      input: (options: { target: string }) => withoutNoise(standard.jsonSchema.input(options)) as JsonSchema,
      output: (options: { target: string }) => withoutNoise(standard.jsonSchema.output(options)) as JsonSchema,
    },
  };
  return new Proxy(schema, {
    get: (target, property, receiver) => (property === "~standard" ? compacted : Reflect.get(target, property, receiver)),
  });
}
