import type { Host } from "./host.ts";
import {
  type ModelChoice,
  type ModelsDocument,
  isRecord,
  ownValue,
} from "./models-file.ts";
import type { SavedProfile } from "./selection.ts";

export type ProfileSource = "environment" | "saved" | "defaultProfile" | "none";

export interface ProfileSelection {
  profile: string | null;
  source: ProfileSource;
  notices: string[];
}

function profileOrigin(
  host: Host,
  source: Exclude<ProfileSource, "none">,
): string {
  switch (source) {
    case "environment":
      return host.variables.profile;
    case "saved":
      return "the saved worktree selection";
    case "defaultProfile":
      return "defaultProfile";
  }
}

/** Takes the first choice that names a defined profile (or "defaults only"); undefined profiles fall through to the next. */
export function selectProfile(
  host: Host,
  document: ModelsDocument,
  environmentProfile: string | undefined,
  savedProfile: SavedProfile,
): ProfileSelection {
  const candidates: [string | null | undefined, ProfileSource][] = [
    [environmentProfile, "environment"],
    [savedProfile, "saved"],
    [document.defaultProfile, "defaultProfile"],
  ];
  const skipped: [string, Exclude<ProfileSource, "none">][] = [];
  let selected: { profile: string | null; source: ProfileSource } = {
    profile: null,
    source: "none",
  };
  for (const [requested, source] of candidates) {
    if (requested === undefined || source === "none") {
      continue;
    }
    if (requested === null || Object.hasOwn(document.profiles, requested)) {
      selected = { profile: requested, source };
      break;
    }
    skipped.push([requested, source]);
  }
  const using =
    selected.profile === null
      ? "defaults only"
      : `profile "${selected.profile}"`;
  return {
    ...selected,
    notices: skipped.map(
      ([requested, source]) =>
        `Profile "${requested}" from ${profileOrigin(host, source)} is not defined in models.jsonc; using ${using}.`,
    ),
  };
}

function providerOf(model: string): string {
  return model.slice(0, model.indexOf("/"));
}

/**
 * The fallback notice for a ref whose model no connected provider offers. The server and the TUI word it the same
 * way, so the TUI does not toast it again when the reload that drops the ref replaces its own check with the server's.
 */
export function unavailableModelNotice(
  host: Host,
  ref: string,
  model: string,
  agents: readonly string[],
  providerConnected: boolean,
): string {
  const providerId = providerOf(model);
  const reason = providerConnected
    ? `"${providerId}" has no model "${model.slice(providerId.length + 1)}"`
    : `provider "${providerId}" is not connected`;
  return `Ref "${ref}" uses ${model}, but ${reason}; ${agents.join(", ")} ${agents.length === 1 ? "falls" : "fall"} back to ${host.name}'s model until you fix the ref or pick another profile.`;
}

export interface RefResolution {
  ref: string;
  model?: string;
  variant?: string;
  /** Names of the other model settings the ref sets: temperature, top_p and each provider option. */
  settings?: string[];
  source: "profile" | "defaults" | "unresolved";
  /** Set when no connected provider offers the model, so agents keep the host's model. */
  unavailable?: true;
  agents: string[];
}

/** A ref that resolved for an agent, and the model the agent had without it, for falling back at runtime. */
export interface RefAssignment {
  agent: string;
  ref: string;
  model: string;
  variant?: string;
  ownModel?: string;
  ownVariant?: string;
  /** The ref's sampling settings and the agent's own, for requests that run on another model. */
  temperature?: number;
  top_p?: number;
  ownTemperature?: number;
  ownTopP?: number;
  /** False when the model was known to be unavailable, so the agent kept its own model. */
  applied: boolean;
}

export interface AppliedModelRefs {
  agents: Record<string, unknown>;
  refs: RefResolution[];
  assignments: RefAssignment[];
  notices: string[];
}

function resolveRef(
  document: ModelsDocument,
  profile: string | null,
  ref: string,
): { choice: ModelChoice; source: "profile" | "defaults" } | undefined {
  const profileRefs =
    profile === null ? undefined : ownValue(document.profiles, profile);
  const profileChoice =
    profileRefs === undefined ? undefined : ownValue(profileRefs, ref);
  if (profileChoice !== undefined) {
    return { choice: profileChoice, source: "profile" };
  }
  const defaultChoice = ownValue(document.defaults, ref);
  return defaultChoice === undefined
    ? undefined
    : { choice: defaultChoice, source: "defaults" };
}

/** Merges like the host merges agent options: nested objects key by key, anything else replaced. */
export function mergeOptions(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeOptions(current, value)
        : value;
  }
  return merged;
}

/** The names of what a ref sets besides its model and variant, for the report. */
export function settingNames(choice: ModelChoice): string[] {
  return [
    ...(choice.temperature === undefined ? [] : ["temperature"]),
    ...(choice.top_p === undefined ? [] : ["top_p"]),
    ...Object.keys(choice.options ?? {}),
  ];
}

/**
 * Sets a ref's model and settings on an agent: the ref's model, variant, temperature and top_p replace the agent's,
 * and its options are merged over the agent's own options, the ref winning where both set a key.
 */
function applyChoice(
  agent: Record<string, unknown>,
  choice: ModelChoice,
): void {
  agent.model = choice.model;
  if (choice.variant !== undefined) {
    agent.variant = choice.variant;
  }
  if (choice.temperature !== undefined) {
    agent.temperature = choice.temperature;
  }
  if (choice.top_p !== undefined) {
    agent.top_p = choice.top_p;
  }
  if (choice.options !== undefined) {
    agent.options = mergeOptions(
      isRecord(agent.options) ? agent.options : {},
      choice.options,
    );
  }
}

/** The sampling settings the host sends with a request, as `chat.params` sees them. */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
}

/**
 * A ref's `temperature` and `top_p` suit its model, and some providers refuse a request that pairs them with another
 * model's settings. So a request from an agent whose ref applied, but which runs on another model (a fallback, or a
 * model picked by hand), gets the agent's own values back, or the provider's default when it had none.
 */
export function restoreOwnSampling(
  assignments: readonly RefAssignment[],
  agent: string,
  model: string,
  params: SamplingParams,
): void {
  const assignment = assignments.find(
    (candidate) => candidate.agent === agent && candidate.applied,
  );
  if (assignment === undefined || assignment.model === model) {
    return;
  }
  // The host leaves temperature unset for a model that does not take one; that stays as it is.
  if (
    assignment.temperature !== undefined &&
    params.temperature !== undefined
  ) {
    params.temperature = assignment.ownTemperature;
  }
  if (assignment.top_p !== undefined) {
    params.topP = assignment.ownTopP;
  }
}

function withoutModelRef(agent: Record<string, unknown>): {
  agent: Record<string, unknown>;
  declared: unknown;
} {
  const { modelRef: topLevel, ...rest } = agent;
  let declared = topLevel;
  if (isRecord(rest.options) && Object.hasOwn(rest.options, "modelRef")) {
    const { modelRef: fromOptions, ...options } = rest.options;
    declared ??= fromOptions;
    rest.options = options;
  }
  return { agent: rest, declared };
}

/**
 * Returns a new agent map and leaves the given one untouched: the host keeps the global config's
 * agent objects for the whole process, so mutating them would lose each modelRef on the next reload.
 */
export function applyModelRefs(
  host: Host,
  configuredAgents: unknown,
  document: ModelsDocument,
  profile: string | null,
  availableModels?: ReadonlySet<string>,
  environment: NodeJS.ProcessEnv = process.env,
): AppliedModelRefs {
  const notices: string[] = [];
  const assignments: RefAssignment[] = [];
  const isAvailable = (model: string) =>
    availableModels === undefined || availableModels.has(model);
  const agents: Record<string, unknown> = {};
  const refAgents = new Map<string, string[]>();
  const configured = isRecord(configuredAgents) ? configuredAgents : {};
  const sourceAgents: Record<string, unknown> = {};
  for (const [name, agent] of Object.entries(configured)) {
    const renamed = ownValue(host.renamedAgents ?? {}, name);
    // An agent configured under its old name is the renamed agent, unless the new name is configured too.
    if (renamed === undefined) {
      sourceAgents[name] = agent;
    } else if (!Object.hasOwn(configured, renamed)) {
      sourceAgents[renamed] = agent;
    }
  }

  const names = [
    ...new Set([
      ...Object.keys(sourceAgents),
      ...Object.keys(document.builtins),
    ]),
  ];
  for (const name of names) {
    const original = ownValue(sourceAgents, name);
    const enabledBy = ownValue(host.experimentalAgents ?? {}, name);
    if (
      original === undefined &&
      enabledBy !== undefined &&
      !enabledBy.some((variable) => {
        const value = environment[variable];
        return value?.toLowerCase() === "true" || value === "1";
      })
    ) {
      notices.push(
        `builtins.${name} is ignored while ${host.name}'s ${name} agent is disabled; set ${enabledBy.join(" or ")} to use it.`,
      );
      continue;
    }
    if (original !== undefined && !isRecord(original)) {
      agents[name] = original;
      continue;
    }
    const { agent, declared } = withoutModelRef(original ?? {});
    const builtInRef =
      host.builtInAgents.includes(name) && agent.model === undefined
        ? ownValue(document.builtins, name)
        : undefined;
    if (
      declared !== undefined &&
      (typeof declared !== "string" || declared.trim() === "")
    ) {
      notices.push(
        `Agent ${name} has a modelRef that is not a ref name; it keeps ${host.name}'s model.`,
      );
    }
    const ref =
      declared === undefined
        ? builtInRef
        : typeof declared === "string" && declared.trim() !== ""
          ? declared
          : undefined;
    if (original === undefined && ref === undefined) {
      continue;
    }
    if (ref === undefined || agent.disable === true) {
      agents[name] = agent;
      continue;
    }
    refAgents.set(ref, [...(refAgents.get(ref) ?? []), name]);
    const resolved = resolveRef(document, profile, ref);
    if (resolved !== undefined) {
      const applied = isAvailable(resolved.choice.model);
      assignments.push({
        agent: name,
        ref,
        model: resolved.choice.model,
        ...(resolved.choice.variant === undefined
          ? {}
          : { variant: resolved.choice.variant }),
        ...(typeof agent.model === "string" ? { ownModel: agent.model } : {}),
        ...(typeof agent.variant === "string"
          ? { ownVariant: agent.variant }
          : {}),
        ...(resolved.choice.temperature === undefined
          ? {}
          : { temperature: resolved.choice.temperature }),
        ...(resolved.choice.top_p === undefined
          ? {}
          : { top_p: resolved.choice.top_p }),
        ...(typeof agent.temperature === "number"
          ? { ownTemperature: agent.temperature }
          : {}),
        ...(typeof agent.top_p === "number" ? { ownTopP: agent.top_p } : {}),
        applied,
      });
      if (applied) {
        applyChoice(agent, resolved.choice);
      }
    }
    if (
      original !== undefined ||
      (resolved !== undefined && isAvailable(resolved.choice.model))
    ) {
      agents[name] = agent;
    }
  }

  const refNames = [
    ...new Set([
      ...Object.keys(document.defaults),
      ...(profile === null
        ? []
        : Object.keys(ownValue(document.profiles, profile) ?? {})),
      ...refAgents.keys(),
    ]),
  ].sort();
  const refs = refNames.map((ref): RefResolution => {
    const users = refAgents.get(ref) ?? [];
    const resolved = resolveRef(document, profile, ref);
    if (resolved === undefined) {
      const where =
        profile === null ? "defaults" : `profile "${profile}" or defaults`;
      notices.push(
        `Ref "${ref}" is not defined in ${where}; ${users.join(", ")} ${users.length === 1 ? "keeps" : "keep"} ${host.name}'s model.`,
      );
      return { ref, source: "unresolved", agents: users };
    }
    const unavailable = !isAvailable(resolved.choice.model);
    const settings = settingNames(resolved.choice);
    if (unavailable && users.length > 0) {
      notices.push(
        unavailableModelNotice(
          host,
          ref,
          resolved.choice.model,
          users,
          availableModels !== undefined &&
            [...availableModels].some((model) =>
              model.startsWith(`${providerOf(resolved.choice.model)}/`),
            ),
        ),
      );
    }
    return {
      ref,
      model: resolved.choice.model,
      ...(resolved.choice.variant === undefined
        ? {}
        : { variant: resolved.choice.variant }),
      ...(settings.length === 0 ? {} : { settings }),
      source: resolved.source,
      ...(unavailable ? { unavailable: true as const } : {}),
      agents: users,
    };
  });
  return { agents, refs, assignments, notices };
}
