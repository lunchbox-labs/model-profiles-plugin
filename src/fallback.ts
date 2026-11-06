import { readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./models-file.ts";
import type { RefAssignment } from "./resolution.ts";

/**
 * Models connected providers offered when last checked, per instance directory. OpenCode keeps the plugin module
 * loaded when it reloads a project, so this outlives the reload that lets the config hook leave unavailable refs
 * unapplied.
 */
const availability = new Map<string, ReadonlySet<string>>();

export function knownAvailableModels(
  directory: string,
): ReadonlySet<string> | undefined {
  return availability.get(directory);
}

export function rememberAvailableModels(
  directory: string,
  models: ReadonlySet<string>,
): void {
  availability.set(directory, models);
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
  assignment: RefAssignment;
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

/**
 * The model OpenCode would use for the agent without its ref: the agent's own `model`, else OpenCode's default
 * (the configured `model`, a recently used model, then a connected provider's default), skipping unavailable ones.
 */
export function fallbackModel(input: FallbackInput): FallbackModel | undefined {
  const { assignment, available, connected } = input;
  if (assignment.ownModel !== undefined && available.has(assignment.ownModel)) {
    return {
      ...split(assignment.ownModel),
      ...(assignment.ownVariant === undefined
        ? {}
        : { variant: assignment.ownVariant }),
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
