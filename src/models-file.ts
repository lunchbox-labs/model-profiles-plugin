import { readFile } from "node:fs/promises";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

export const builtInAgentNames = [
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
] as const;

export interface ModelChoice {
  model: string;
  variant?: string;
}

export interface ModelsDocument {
  defaultProfile?: string;
  defaults: Record<string, ModelChoice>;
  profiles: Record<string, Record<string, ModelChoice>>;
  builtins: Record<string, string>;
}

export interface LoadedModels {
  document: ModelsDocument;
  /** "unusable" means the file exists but could not be read or parsed, so it contributes nothing. */
  status: "loaded" | "missing" | "unusable";
  notices: string[];
}

export function emptyModelsDocument(): ModelsDocument {
  return { defaults: {}, profiles: {}, builtins: {} };
}

export function ownValue<Value>(
  record: Record<string, Value>,
  key: string,
): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const modelIdentifierPattern = /^[^\s/]+\/\S+$/;

function readModelChoice(value: unknown): ModelChoice | undefined {
  if (typeof value === "string") {
    return modelIdentifierPattern.test(value) ? { model: value } : undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    !modelIdentifierPattern.test(value.model)
  ) {
    return undefined;
  }
  if (value.variant === undefined) {
    return { model: value.model };
  }
  return isNonEmptyName(value.variant)
    ? { model: value.model, variant: value.variant }
    : undefined;
}

function readModelChoices(
  value: unknown,
  location: string,
  notices: string[],
): Record<string, ModelChoice> {
  const choices: Record<string, ModelChoice> = {};
  if (value === undefined) {
    return choices;
  }
  if (!isRecord(value)) {
    notices.push(`${location} is not an object of model refs; ignored.`);
    return choices;
  }
  for (const [ref, entry] of Object.entries(value)) {
    const choice = readModelChoice(entry);
    if (choice === undefined || !isNonEmptyName(ref)) {
      notices.push(
        `${location}.${ref} is not "provider/model" or { "model", "variant" }; skipped.`,
      );
      continue;
    }
    choices[ref] = choice;
  }
  return choices;
}

function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`;
}

export function parseModelsDocument(text: string, path: string): LoadedModels {
  const notices: string[] = [];
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const firstError = errors.at(0);
  if (firstError !== undefined) {
    notices.push(
      `${path} has a syntax error (${printParseErrorCode(firstError.error)} at ${lineAndColumn(text, firstError.offset)}); its model refs are ignored.`,
    );
    return { document: emptyModelsDocument(), status: "unusable", notices };
  }
  if (!isRecord(value)) {
    notices.push(`${path} is not a JSON object; its model refs are ignored.`);
    return { document: emptyModelsDocument(), status: "unusable", notices };
  }

  const knownKeys = [
    "$schema",
    "defaultProfile",
    "defaults",
    "profiles",
    "builtins",
  ];
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) {
      notices.push(`Unknown top-level key "${key}" in ${path}; ignored.`);
    }
  }

  const document = emptyModelsDocument();
  document.defaults = readModelChoices(value.defaults, "defaults", notices);

  if (value.profiles !== undefined && !isRecord(value.profiles)) {
    notices.push("profiles is not an object of profiles; ignored.");
  } else {
    for (const [name, refs] of Object.entries(value.profiles ?? {})) {
      if (!isNonEmptyName(name)) {
        notices.push("A profile with an empty name was skipped.");
        continue;
      }
      document.profiles[name] = readModelChoices(
        refs,
        `profiles.${name}`,
        notices,
      );
    }
  }

  if (value.builtins !== undefined && !isRecord(value.builtins)) {
    notices.push("builtins is not an object of agent names; ignored.");
  } else {
    const knownBuiltIns: readonly string[] = builtInAgentNames;
    for (const [agent, ref] of Object.entries(value.builtins ?? {})) {
      if (!knownBuiltIns.includes(agent)) {
        notices.push(
          `builtins.${agent} is not a built-in agent (${builtInAgentNames.join(", ")}); skipped.`,
        );
      } else if (!isNonEmptyName(ref)) {
        notices.push(`builtins.${agent} is not a ref name; skipped.`);
      } else {
        document.builtins[agent] = ref;
      }
    }
  }

  if (value.defaultProfile !== undefined) {
    if (isNonEmptyName(value.defaultProfile)) {
      document.defaultProfile = value.defaultProfile;
    } else {
      notices.push("defaultProfile is not a profile name; ignored.");
    }
  }
  return { document, status: "loaded", notices };
}

export async function loadModelsDocument(path: string): Promise<LoadedModels> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        document: emptyModelsDocument(),
        status: "missing",
        notices: [],
      };
    }
    return {
      document: emptyModelsDocument(),
      status: "unusable",
      notices: [
        `Could not read ${path} (${error instanceof Error ? error.message : String(error)}); its model refs are ignored.`,
      ],
    };
  }
  return parseModelsDocument(text, path);
}
