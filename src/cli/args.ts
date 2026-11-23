import { parseArgs, type ParseArgsConfig } from "node:util";
import { z } from "zod";
import { KitError } from "../core/errors";
import type { CommandDef } from "./registry";

/** Flags every command takes. */
export const GlobalOptions = z.object({
  profile: z.string().min(1).optional().describe("AWS profile to use instead of the configured operator profile"),
});

type BaseType = "string" | "boolean" | "number" | "array" | "enum";

export function baseType(schema: z.ZodType): BaseType {
  const def = (schema as unknown as { def: { type: string; innerType?: z.ZodType } }).def;
  if ((def.type === "optional" || def.type === "default" || def.type === "nullable") && def.innerType) return baseType(def.innerType);
  if (def.type === "boolean" || def.type === "number" || def.type === "array" || def.type === "enum") return def.type;
  return "string";
}

export const toFlag = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
export const toKey = (flag: string) => flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export interface ParsedArgs<S extends z.ZodObject> {
  options: z.infer<S>;
  global: z.infer<typeof GlobalOptions>;
  positionals: string[];
}

export function parseCommandArgs<S extends z.ZodObject>(def: CommandDef<S>, argv: string[]): ParsedArgs<S> {
  const shape = { ...GlobalOptions.shape, ...def.options.shape } as Record<string, z.ZodType>;
  const types = Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, baseType(schema)]));
  const config: ParseArgsConfig["options"] = {};
  for (const [key, type] of Object.entries(types)) {
    config[toFlag(key)] = { type: type === "boolean" ? "boolean" : "string", ...(type === "array" ? { multiple: true } : {}) };
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: config, allowPositionals: true, strict: true });
  } catch (error) {
    throw new KitError("bad_args", (error as Error).message, `See: aws-kit help ${def.name}`);
  }
  const raw: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(parsed.values)) {
    const key = toKey(flag);
    raw[key] = types[key] === "number" ? Number(value) : value;
  }
  const options = def.options.safeParse(raw);
  if (!options.success) throw new KitError("bad_args", z.prettifyError(options.error), `See: aws-kit help ${def.name}`);
  return { options: options.data, global: GlobalOptions.parse(raw), positionals: parsed.positionals };
}

/** Help as data, so an agent can read every command and flag in one call. */
export function describeCommand(def: CommandDef) {
  const schema = z.toJSONSchema(def.options, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>;
    required?: string[];
  };
  const options = Object.entries(schema.properties ?? {}).map(([key, property]) => ({
    flag: `--${toFlag(key)}`,
    type: property.enum ? property.enum.join("|") : (property.type ?? "string"),
    required: schema.required?.includes(key) ?? false,
    ...(property.default !== undefined ? { default: property.default } : {}),
    description: property.description ?? "",
  }));
  return {
    name: def.name,
    summary: def.summary,
    mutates: def.mutates ?? false,
    ...(def.positionals ? { positionals: def.positionals } : {}),
    options,
  };
}
