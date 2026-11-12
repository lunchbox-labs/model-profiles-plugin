import { homedir } from "node:os";
import path from "node:path";
import type { Host } from "./host.ts";
import {
  type LoadedModels,
  isRecord,
  loadModelsDocument,
} from "./models-file.ts";
import type { ModelProfilesReport } from "./report.ts";
import {
  type RefAssignment,
  applyModelRefs,
  selectProfile,
} from "./resolution.ts";
import {
  configurationDirectory,
  processProfile,
  readSavedSelection,
  selectionFilePath,
  stateDirectory,
} from "./selection.ts";

export function modelsFilePath(
  host: Host,
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const directory = configurationDirectory(host, environment);
  const configured = isRecord(options) ? options.configFile : undefined;
  if (typeof configured !== "string" || configured.trim() === "") {
    return path.join(directory, "models.jsonc");
  }
  // `~` is the home directory, as in a shell, rather than a folder named "~" in the config directory.
  if (
    configured === "~" ||
    configured.startsWith("~/") ||
    configured.startsWith("~\\")
  ) {
    return path.resolve(
      (environment[host.variables.testHome] ?? homedir()).trim(),
      configured.slice(2),
    );
  }
  return path.resolve(directory, configured);
}

function usesModelRefs(agents: unknown): boolean {
  return (
    isRecord(agents) &&
    Object.values(agents).some(
      (agent) =>
        isRecord(agent) &&
        (Object.hasOwn(agent, "modelRef") ||
          (isRecord(agent.options) &&
            Object.hasOwn(agent.options, "modelRef"))),
    )
  );
}

export interface ResolveInput {
  configFile: string;
  worktree: string;
  environment?: NodeJS.ProcessEnv;
  /** Models connected providers offered when last checked; refs to others are not applied. Unknown until checked. */
  availableModels?: ReadonlySet<string>;
}

export interface ResolvedModelProfiles {
  report: ModelProfilesReport;
  assignments: RefAssignment[];
}

/** Replaces `config.agent` with resolved copies and returns what was applied; never throws for bad input files. */
export async function resolveModelProfiles(
  host: Host,
  config: Record<string, unknown>,
  input: ResolveInput,
): Promise<ResolvedModelProfiles> {
  const environment = input.environment ?? process.env;
  const selectionFile = selectionFilePath(
    stateDirectory(host, environment),
    input.worktree,
  );
  const loaded: LoadedModels = await loadModelsDocument(host, input.configFile);
  const notices = [...loaded.notices];
  if (loaded.status === "missing" && usesModelRefs(config.agent)) {
    notices.push(
      `No models file at ${input.configFile}; agents with a modelRef keep ${host.name}'s model.`,
    );
  }
  const environmentProfile = processProfile(host, environment);
  const saved = await readSavedSelection(selectionFile);
  if (saved.notice !== undefined) {
    notices.push(saved.notice);
  }
  const selection = selectProfile(
    host,
    loaded.document,
    environmentProfile,
    saved.profile,
  );
  const applied = applyModelRefs(
    host,
    config.agent,
    loaded.document,
    selection.profile,
    input.availableModels,
    environment,
  );
  if (loaded.status === "loaded") {
    notices.push(...selection.notices, ...applied.notices);
  }
  if (isRecord(config.agent) || Object.keys(applied.agents).length > 0) {
    config.agent = applied.agents;
  }
  const report: ModelProfilesReport = {
    version: 1,
    configFile: input.configFile,
    selectionFile,
    worktree: input.worktree,
    profiles: Object.keys(loaded.document.profiles),
    profile: selection.profile,
    profileSource: selection.source,
    ...(environmentProfile === undefined ? {} : { environmentProfile }),
    refs: applied.refs,
    notices,
  };
  return { report, assignments: applied.assignments };
}

/** The last resort when resolution fails unexpectedly: the host's models stay, and modelRef never reaches a provider. */
export function stripModelRefs(config: Record<string, unknown>): void {
  if (!isRecord(config.agent)) {
    return;
  }
  config.agent = Object.fromEntries(
    Object.entries(config.agent).map(([name, agent]) => {
      if (!isRecord(agent)) {
        return [name, agent];
      }
      const { modelRef: _modelRef, ...rest } = agent;
      if (isRecord(rest.options)) {
        const { modelRef: _optionsModelRef, ...options } = rest.options;
        rest.options = options;
      }
      return [name, rest];
    }),
  );
}
