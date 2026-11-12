import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Host } from "./host.ts";
import { isRecord } from "./models-file.ts";
import type { RefAssignment } from "./resolution.ts";

/**
 * Models connected providers offered when last checked, per instance directory and provider setup. The host keeps
 * the plugin module loaded when it reloads a project, so this outlives the reload that lets the config hook leave
 * unavailable refs unapplied. It is also saved in the host's state directory, so a new process (such as
 * `opencode run` or `kilo run`) leaves them out from the start.
 */
const availability = new Map<string, ReadonlySet<string>>();

/**
 * Every model a ref has put on an agent, per directory, also saved. A session can keep asking for one after its ref
 * is fixed or left out, and only those are moved when the host took the model from the agent or the session.
 */
const refModels = new Map<string, ReadonlySet<string>>();

export function knownRefModels(directory: string): ReadonlySet<string> {
  return refModels.get(directory) ?? new Set();
}

/**
 * Variables the provider loaders OpenCode and Kilo share read besides the catalog's lists, such as Bedrock's region
 * and profile. A host adds its own in `Host.loaderVariables`.
 */
const loaderVariables = [
  "AICORE_DEPLOYMENT_ID",
  "AICORE_RESOURCE_GROUP",
  "AICORE_SERVICE_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
  "AZURE_RESOURCE_NAME",
  "CF_AIG_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_GATEWAY_ID",
  "GCLOUD_PROJECT",
  "GCP_PROJECT",
  "GITLAB_INSTANCE_URL",
  "GITLAB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_VERTEX_LOCATION",
  "GOOGLE_VERTEX_PROJECT",
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_CORTEX_PAT",
  "SNOWFLAKE_CORTEX_TOKEN",
  "VERTEX_LOCATION",
];

/** Used only when the host's models.dev catalog is not cached, so which variables providers read is unknown. */
const credentialLikeVariable =
  /TOKEN|(?:API_KEY|SECRET|ACCESS_KEY|CREDENTIALS|_PROFILE|_PROJECT|_REGION|_LOCATION|_RESOURCE_NAME)$/;

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

/** The environment variables each provider in the host's cached models.dev catalog connects with; undefined without it. */
async function catalogVariables(
  modelsFile: string,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const catalog: unknown = JSON.parse(await readFile(modelsFile, "utf8"));
    if (!isRecord(catalog)) {
      return undefined;
    }
    const names = Object.values(catalog).flatMap((provider) =>
      isRecord(provider) ? sortedStrings(provider.env) : [],
    );
    return names.length === 0
      ? undefined
      : new Set(names.map((name) => name.toUpperCase()));
  } catch {
    return undefined;
  }
}

/** The file the host caches its models.dev catalog in: `models.json` for its default source, else one per source URL. */
function catalogFileName(host: Host, environment: NodeJS.ProcessEnv): string {
  const configured = environment[host.modelsUrl.variable];
  const source =
    configured === undefined || configured === ""
      ? host.modelsUrl.defaultUrl
      : configured;
  return source === host.modelsUrl.defaultUrl
    ? "models.json"
    : `models-${createHash("sha1").update(source).digest("hex")}.json`;
}

/**
 * Identifies what decides which providers connect, without reading any secret: the provider config, which
 * providers `auth.json` holds credentials for, which provider variables are set (by name only) and what the host's
 * `providerSetup` adds. Processes started from different environments on one directory then keep separate
 * availability instead of overwriting each other's.
 */
export async function providerSetupKey(
  host: Host,
  config: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  directories: { data: string; cache: string },
): Promise<string> {
  let auth: unknown;
  try {
    auth = JSON.parse(
      await readFile(path.join(directories.data, "auth.json"), "utf8"),
    );
  } catch {
    // Without auth.json only the config and the environment tell setups apart.
  }
  // Only the provider ids are kept; the credentials under them never reach the key.
  const authProviders = isRecord(auth) ? Object.keys(auth).sort() : [];
  const catalog = await catalogVariables(
    environment[host.variables.modelsPath] ??
      path.join(directories.cache, catalogFileName(host, environment)),
  );
  const isProviderVariable = (name: string) =>
    name !== host.variables.profile &&
    (loaderVariables.includes(name) ||
      host.loaderVariables.includes(name) ||
      (catalog === undefined
        ? credentialLikeVariable.test(name)
        : catalog.has(name)));
  const providers = isRecord(config.provider)
    ? Object.entries(config.provider)
        .map(([id, provider]) => ({
          id,
          models:
            isRecord(provider) && isRecord(provider.models)
              ? Object.keys(provider.models).sort()
              : [],
          whitelist: isRecord(provider)
            ? sortedStrings(provider.whitelist)
            : [],
          blacklist: isRecord(provider)
            ? sortedStrings(provider.blacklist)
            : [],
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    : [];
  const variables = Object.entries(environment)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name]) => name.toUpperCase())
    .filter(isProviderVariable)
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        providers,
        enabled: sortedStrings(config.enabled_providers),
        disabled: sortedStrings(config.disabled_providers),
        authProviders,
        variables,
        ...host.providerSetup?.({ config, environment, auth }),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Provider setups kept per directory; older ones are removed when a newer one is saved. */
const keptProviderSetups = 8;

function directoryKey(directory: string): string {
  return createHash("sha256")
    .update(
      process.platform === "win32"
        ? path.resolve(directory).toLowerCase()
        : path.resolve(directory),
    )
    .digest("hex")
    .slice(0, 32);
}

function availabilityFolder(state: string): string {
  return path.join(state, "model-profiles", "available");
}

export function availabilityFilePath(
  state: string,
  directory: string,
  providerSetup: string,
): string {
  return path.join(
    availabilityFolder(state),
    `${directoryKey(directory)}-${providerSetup}.json`,
  );
}

/** Before 0.1.3 one file held a directory's availability whatever the provider setup. */
function legacyAvailabilityFilePath(state: string, directory: string): string {
  return path.join(
    availabilityFolder(state),
    `${directoryKey(directory)}.json`,
  );
}

/** Removes all but the most recently saved or loaded setups of this directory; best-effort. */
async function pruneProviderSetups(
  state: string,
  directory: string,
  currentFile: string,
): Promise<void> {
  const folder = availabilityFolder(state);
  const prefix = `${directoryKey(directory)}-`;
  const others = (await readdir(folder)).filter(
    (name) =>
      name.startsWith(prefix) &&
      name.endsWith(".json") &&
      name !== path.basename(currentFile),
  );
  if (others.length < keptProviderSetups) {
    return;
  }
  const dated = await Promise.all(
    others.map(async (name) => ({
      name,
      modified: (await stat(path.join(folder, name)).catch(() => undefined))
        ?.mtimeMs,
    })),
  );
  dated.sort((left, right) => (right.modified ?? 0) - (left.modified ?? 0));
  for (const { name } of dated.slice(keptProviderSetups - 1)) {
    await rm(path.join(folder, name), { force: true }).catch(() => undefined);
  }
}

interface SavedAvailability {
  models: ReadonlySet<string>;
  refModels: ReadonlySet<string>;
}

async function readAvailabilityFile(
  file: string,
): Promise<SavedAvailability | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      isRecord(value) &&
      value.version === 1 &&
      Array.isArray(value.models) &&
      value.models.every((model: unknown) => typeof model === "string")
    ) {
      return {
        models: new Set(value.models),
        refModels: new Set(sortedStrings(value.refModels)),
      };
    }
  } catch {
    // A missing or unreadable file means availability is not known yet.
  }
  return undefined;
}

/** Adds the ref models saved by this directory's other provider setups to memory; best-effort. */
async function rememberOtherSetupRefModels(
  state: string,
  directory: string,
  currentFile: string,
): Promise<void> {
  const folder = availabilityFolder(state);
  const prefix = `${directoryKey(directory)}-`;
  const names = await readdir(folder).catch(() => []);
  const others = names.filter(
    (name) =>
      name.startsWith(prefix) &&
      name.endsWith(".json") &&
      name !== path.basename(currentFile),
  );
  const saved = await Promise.all(
    others.map((name) => readAvailabilityFile(path.join(folder, name))),
  );
  const refs = saved.flatMap((file) => [...(file?.refModels ?? [])]);
  if (refs.length > 0) {
    refModels.set(directory, new Set([...knownRefModels(directory), ...refs]));
  }
}

function memoryKey(directory: string, providerSetup: string): string {
  return `${directory}\n${providerSetup}`;
}

/** The models last seen for this directory and provider setup, from memory or the state file; undefined when never checked. */
export async function knownAvailableModels(
  state: string,
  directory: string,
  providerSetup: string,
): Promise<ReadonlySet<string> | undefined> {
  const known = availability.get(memoryKey(directory, providerSetup));
  if (known !== undefined) {
    return known;
  }
  const file = availabilityFilePath(state, directory, providerSetup);
  const saved = await readAvailabilityFile(file);
  if (saved === undefined) {
    // A new setup starts without availability, but the ref models other setups of this directory saved still
    // name the models a session may keep asking for.
    await rememberOtherSetupRefModels(state, directory, file);
    return undefined;
  }
  // A file is rewritten only when availability changes, so loading it marks the setup as in use for pruning.
  const now = new Date();
  await utimes(file, now, now).catch(() => undefined);
  availability.set(memoryKey(directory, providerSetup), saved.models);
  refModels.set(
    directory,
    new Set([...knownRefModels(directory), ...saved.refModels]),
  );
  return saved.models;
}

export function availabilityKey(models: ReadonlySet<string>): string {
  return [...models].sort().join("\n");
}

/**
 * Remembers the models for this directory and provider setup and the ref models seen, saving them when they
 * changed; best-effort. The file is replaced atomically, and ref models another process saved are kept.
 */
export async function rememberAvailableModels(
  state: string,
  directory: string,
  providerSetup: string,
  models: ReadonlySet<string>,
  assigned: Iterable<string> = [],
): Promise<void> {
  const key = memoryKey(directory, providerSetup);
  const previous = availability.get(key);
  const previousRefs = knownRefModels(directory);
  const refs = new Set([...previousRefs, ...assigned]);
  availability.set(key, models);
  refModels.set(directory, refs);
  if (
    previous !== undefined &&
    availabilityKey(previous) === availabilityKey(models) &&
    refs.size === previousRefs.size
  ) {
    return;
  }
  const file = availabilityFilePath(state, directory, providerSetup);
  const legacyFile = legacyAvailabilityFilePath(state, directory);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    // The legacy file's models may come from another setup, so only its ref models carry over.
    const legacyRefs = (await readAvailabilityFile(legacyFile))?.refModels;
    if (legacyRefs !== undefined) {
      refModels.set(directory, new Set([...refs, ...legacyRefs]));
    }
    const saved = await readAvailabilityFile(file);
    const mergedRefs = [
      ...new Set([...(saved?.refModels ?? []), ...knownRefModels(directory)]),
    ];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, directory, models: [...models].sort(), refModels: mergedRefs.sort() })}\n`,
      "utf8",
    );
    await rename(temporary, file);
    await rm(legacyFile, { force: true });
    await pruneProviderSetups(state, directory, file);
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

/** Reads the host's provider list response; anything unexpected yields undefined so nothing changes. */
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

/** The host's recently used models, which it tries before a provider's default when no `model` is set. */
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
  /** The model of the session that started this subagent, which the host gives a subagent without a model. */
  parentModel?: string;
  available: ReadonlySet<string>;
  connected: ConnectedProviders;
  /** The top-level `model` from the host's config. */
  configuredModel?: string;
  /** Provider ids configured under `provider`, which the host prefers for its default. */
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
 * The model the host would use for the agent without its ref: the agent's own `model`, else for a subagent its
 * parent's model, else the host's default (the configured `model`, a recently used model, then a connected
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
