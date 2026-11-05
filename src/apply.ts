import path from "node:path";
import {
  type LoadedModels,
  isRecord,
  loadModelsDocument,
} from "./models-file.ts";
import type { ModelProfilesReport } from "./report.ts";
import { applyModelRefs, selectProfile } from "./resolution.ts";
import {
  configurationDirectory,
  processProfile,
  readSavedSelection,
  selectionFilePath,
  stateDirectory,
} from "./selection.ts";

export function modelsFilePath(
  options: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const directory = configurationDirectory(environment);
  const configured = isRecord(options) ? options.configFile : undefined;
  return typeof configured === "string" && configured.trim() !== ""
    ? path.resolve(directory, configured)
    : path.join(directory, "models.jsonc");
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
}

/** Replaces `config.agent` with resolved copies and returns what was applied; never throws for bad input files. */
export async function resolveModelProfiles(
  config: Record<string, unknown>,
  input: ResolveInput,
): Promise<ModelProfilesReport> {
  const environment = input.environment ?? process.env;
  const selectionFile = selectionFilePath(
    stateDirectory(environment),
    input.worktree,
  );
  const loaded: LoadedModels = await loadModelsDocument(input.configFile);
  const notices = [...loaded.notices];
  if (loaded.status === "missing" && usesModelRefs(config.agent)) {
    notices.push(
      `No models file at ${input.configFile}; agents with a modelRef keep OpenCode's model.`,
    );
  }
  const environmentProfile = processProfile(environment);
  const saved =
    environmentProfile === undefined
      ? await readSavedSelection(selectionFile)
      : { profile: undefined };
  if (saved.notice !== undefined) {
    notices.push(saved.notice);
  }
  const selection = selectProfile(
    loaded.document,
    environmentProfile,
    saved.profile,
  );
  const applied = applyModelRefs(
    config.agent,
    loaded.document,
    selection.profile,
  );
  if (loaded.status === "loaded") {
    notices.push(...selection.notices, ...applied.notices);
  }
  if (isRecord(config.agent) || Object.keys(applied.agents).length > 0) {
    config.agent = applied.agents;
  }
  return {
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
}

/** The last resort when resolution fails unexpectedly: OpenCode's models stay, and modelRef never reaches a provider. */
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
