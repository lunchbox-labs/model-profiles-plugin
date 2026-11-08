import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./models-file.ts";
import type { RefAssignment } from "./resolution.ts";

/**
 * Models connected providers offered when last checked, per instance directory. OpenCode keeps the plugin module
 * loaded when it reloads a project, so this outlives the reload that lets the config hook leave unavailable refs
 * unapplied. It is also saved in OpenCode's state directory, so a new process (such as `opencode run`) leaves them
 * out from the start.
 */
const availability = new Map<string, ReadonlySet<string>>();

/**
 * Every model a ref has put on an agent, per directory, also saved. A session can keep asking for one after its ref
 * is fixed or left out, and only those are moved when OpenCode took the model from the agent or the session.
 */
const refModels = new Map<string, ReadonlySet<string>>();

export function knownRefModels(directory: string): ReadonlySet<string> {
  return refModels.get(directory) ?? new Set();
}

export function availabilityFilePath(state: string, directory: string): string {
  const key = createHash("sha256")
    .update(
      process.platform === "win32"
        ? path.resolve(directory).toLowerCase()
        : path.resolve(directory),
    )
    .digest("hex")
    .slice(0, 32);
  return path.join(state, "model-profiles", "available", `${key}.json`);
}

/** The models last seen for this directory, from memory or the state file; undefined when never checked. */
export async function knownAvailableModels(
  state: string,
  directory: string,
): Promise<ReadonlySet<string> | undefined> {
  const known = availability.get(directory);
  if (known !== undefined) {
    return known;
  }
  try {
    const value: unknown = JSON.parse(
      await readFile(availabilityFilePath(state, directory), "utf8"),
    );
    if (
      isRecord(value) &&
      value.version === 1 &&
      Array.isArray(value.models) &&
      value.models.every((model: unknown) => typeof model === "string")
    ) {
      const models = new Set(value.models);
      availability.set(directory, models);
      if (
        !refModels.has(directory) &&
        Array.isArray(value.refModels) &&
        value.refModels.every((model: unknown) => typeof model === "string")
      ) {
        refModels.set(directory, new Set(value.refModels));
      }
      return models;
    }
  } catch {
    // A missing or unreadable file means availability is not known yet.
  }
  return undefined;
}

export function availabilityKey(models: ReadonlySet<string>): string {
  return [...models].sort().join("\n");
}

/** Remembers the models for this directory and the ref models seen, saving them when they changed; best-effort. */
export async function rememberAvailableModels(
  state: string,
  directory: string,
  models: ReadonlySet<string>,
  assigned: Iterable<string> = [],
): Promise<void> {
  const previous = availability.get(directory);
  const previousRefs = knownRefModels(directory);
  const refs = new Set([...previousRefs, ...assigned]);
  availability.set(directory, models);
  refModels.set(directory, refs);
  if (
    previous !== undefined &&
    availabilityKey(previous) === availabilityKey(models) &&
    refs.size === previousRefs.size
  ) {
    return;
  }
  const file = availabilityFilePath(state, directory);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, directory, models: [...models].sort(), refModels: [...refs].sort() })}\n`,
      "utf8",
    );
    await rename(temporary, file);
  } catch {
    // Without the file the next process learns availability on its first prompt instead.
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface ConnectedProviders {
  providers: { id: string; models: Record<string, unknown> }[];
  default: Record<string, string>;
}

/** Reads OpenCode's provider list response; anything unexpected yields undefined so nothing changes. */
export function readConnectedProviders(
  data: unknown,
): ConnectedProviders | undefined {
  if (!isRecord(data) || !Array.isArray(data.providers)) {
    return undefined;
  }
  const providers = data.providers.flatMap((provider: unknown) =>
    isRecord(provider) &&
    typeof provider.id === "string" &&
    isRecord(provider.models)
      ? [{ id: provider.id, models: provider.models }]
      : [],
  );
  const defaults = isRecord(data.default)
    ? Object.fromEntries(
        Object.entries(data.default).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  return { providers, default: defaults };
}

export function availableModels(
  connected: ConnectedProviders,
): ReadonlySet<string> {
  return new Set(
    connected.providers.flatMap((provider) =>
      Object.keys(provider.models).map((model) => `${provider.id}/${model}`),
    ),
  );
}

/** True when the agents the config hook built no longer match what is available, so a reload would change them. */
export function assignmentsAreStale(
  assignments: readonly RefAssignment[],
  available: ReadonlySet<string>,
): boolean {
  return assignments.some(
    (assignment) => assignment.applied !== available.has(assignment.model),
  );
}

/** Which way the applied refs went stale: refs applied to models now missing, or refs left out whose models are back. */
export function staleDirections(
  assignments: readonly RefAssignment[],
  available: ReadonlySet<string>,
): { nowUnavailable: boolean; availableAgain: boolean } {
  return {
    nowUnavailable: assignments.some(
      (assignment) => assignment.applied && !available.has(assignment.model),
    ),
    availableAgain: assignments.some(
      (assignment) => !assignment.applied && available.has(assignment.model),
    ),
  };
}

/** OpenCode's recently used models, which it tries before a provider's default when no `model` is set. */
export async function recentModels(state: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(state, "model.json"), "utf8"),
    );
    if (!isRecord(value) || !Array.isArray(value.recent)) {
      return [];
    }
    return value.recent.flatMap((entry: unknown) =>
      isRecord(entry) &&
      typeof entry.providerID === "string" &&
      typeof entry.modelID === "string"
        ? [`${entry.providerID}/${entry.modelID}`]
        : [],
    );
  } catch {
    return [];
  }
}

export interface FallbackInput {
  /** The agent's own model and variant, when it had one besides its ref. */
  own?: { model: string; variant?: string };
  /** The model of the session that started this subagent, which OpenCode gives a subagent without a model. */
  parentModel?: string;
  available: ReadonlySet<string>;
  connected: ConnectedProviders;
  /** The top-level `model` from OpenCode's config. */
  configuredModel?: string;
  /** Provider ids configured under `provider`, which OpenCode prefers for its default. */
  configuredProviders: readonly string[];
  recent: readonly string[];
}

export interface FallbackModel {
  providerID: string;
  modelID: string;
  variant?: string;
}

function split(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function hasVariant(
  connected: ConnectedProviders,
  model: string,
  variant: string,
): boolean {
  const { providerID, modelID } = split(model);
  const info = connected.providers.find(
    (provider) => provider.id === providerID,
  )?.models[modelID];
  // Only a model that lists its variants can be known not to offer one.
  return (
    !isRecord(info) ||
    !isRecord(info.variants) ||
    Object.hasOwn(info.variants, variant)
  );
}

/**
 * The model OpenCode would use for the agent without its ref: the agent's own `model`, else for a subagent its
 * parent's model, else OpenCode's default (the configured `model`, a recently used model, then a connected
 * provider's default), skipping unavailable ones.
 */
export function fallbackModel(input: FallbackInput): FallbackModel | undefined {
  const { own, available, connected } = input;
  if (own !== undefined && available.has(own.model)) {
    return {
      ...split(own.model),
      ...(own.variant !== undefined &&
      hasVariant(connected, own.model, own.variant)
        ? { variant: own.variant }
        : {}),
    };
  }
  const provider = connected.providers.find(
    (candidate) =>
      input.configuredProviders.length === 0 ||
      input.configuredProviders.includes(candidate.id),
  );
  const providerDefault =
    provider === undefined ? undefined : connected.default[provider.id];
  const candidates = [
    input.parentModel,
    input.configuredModel,
    ...input.recent,
    provider === undefined || providerDefault === undefined
      ? undefined
      : `${provider.id}/${providerDefault}`,
  ];
  const model = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && available.has(candidate),
  );
  return model === undefined ? undefined : split(model);
}
