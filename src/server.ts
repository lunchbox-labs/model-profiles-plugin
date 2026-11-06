import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import {
  modelsFilePath,
  resolveModelProfiles,
  stripModelRefs,
} from "./apply.ts";
import {
  assignmentsAreStale,
  availableModels,
  fallbackModel,
  knownAvailableModels,
  readConnectedProviders,
  recentModels,
  rememberAvailableModels,
} from "./fallback.ts";
import { isRecord } from "./models-file.ts";
import { publishReport } from "./report.ts";
import type { RefAssignment } from "./resolution.ts";
import {
  selectionFilePath,
  stateDirectory,
  worktreeRoot,
} from "./selection.ts";

const logService = "model-profiles";

interface Applied {
  assignments: RefAssignment[];
  configuredModel?: string;
  configuredProviders: string[];
}

/**
 * Keeps agents usable when a ref names a model no connected provider offers. The config hook runs before
 * providers load, so it cannot check models itself: a prompt to such a model is moved to the model OpenCode
 * would use without the ref, and once OpenCode is idle the project reloads so the config hook leaves those refs
 * unapplied (which also covers built-in agents such as compaction that never pass through a prompt).
 */
function createFallbacks(input: PluginInput, getApplied: () => Applied) {
  const { client, directory } = input;
  let reloadWanted = false;
  let reloading = false;

  const log = (message: string) =>
    client.app
      .log({
        body: { service: logService, level: "warn", message },
        query: { directory },
      })
      .catch(() => undefined);

  const checkMessage = async (message: Record<string, unknown>) => {
    const applied = getApplied();
    if (applied.assignments.length === 0) {
      return;
    }
    const response = await client.config.providers({ query: { directory } });
    const connected =
      response.error === undefined
        ? readConnectedProviders(response.data)
        : undefined;
    if (connected === undefined) {
      return;
    }
    const available = availableModels(connected);
    rememberAvailableModels(directory, available);
    if (assignmentsAreStale(applied.assignments, available)) {
      reloadWanted = true;
    }

    const model = message.model;
    if (
      !isRecord(model) ||
      typeof model.providerID !== "string" ||
      typeof model.modelID !== "string"
    ) {
      return;
    }
    const requested = `${model.providerID}/${model.modelID}`;
    const assignment = applied.assignments.find(
      // Not only applied refs: OpenCode stores a session's model before this hook runs, so a session started before
      // the reload keeps asking for the unavailable model.
      (candidate) =>
        candidate.agent === message.agent && candidate.model === requested,
    );
    if (assignment === undefined || available.has(requested)) {
      return;
    }
    const fallback = fallbackModel({
      assignment,
      available,
      connected,
      ...(applied.configuredModel === undefined
        ? {}
        : { configuredModel: applied.configuredModel }),
      configuredProviders: applied.configuredProviders,
      recent: await recentModels(stateDirectory()),
    });
    if (fallback === undefined) {
      return;
    }
    message.model = fallback;
    await log(
      `Ref "${assignment.ref}" uses ${requested}, which no connected provider offers; ${assignment.agent} uses ${fallback.providerID}/${fallback.modelID} instead.`,
    );
  };

  const reloadWhenIdle = async () => {
    const status = await client.session.status({ query: { directory } });
    if (
      status.error !== undefined ||
      !isRecord(status.data) ||
      Object.values(status.data).some(
        (session) => !isRecord(session) || session.type !== "idle",
      )
    ) {
      return;
    }
    reloadWanted = false;
    await client.instance.dispose({ query: { directory } });
  };

  return {
    message: async (message: unknown) => {
      if (isRecord(message)) {
        await checkMessage(message);
      }
    },
    idle: () => {
      if (!reloadWanted || reloading) {
        return;
      }
      reloading = true;
      // Disposing from inside the event that reports idleness would wait on this very hook.
      setTimeout(() => {
        reloadWhenIdle()
          .catch(() => undefined)
          .finally(() => {
            reloading = false;
          });
      }, 0);
    },
  };
}

const ModelProfilesServer: Plugin = (input, options) => {
  const worktree = worktreeRoot(input.worktree, input.directory);
  let applied: Applied = { assignments: [], configuredProviders: [] };
  const fallbacks = createFallbacks(input, () => applied);
  return Promise.resolve({
    config: async (config) => {
      const target = config as Record<string, unknown>;
      const configFile = modelsFilePath(options);
      try {
        const available = knownAvailableModels(input.directory);
        const resolved = await resolveModelProfiles(target, {
          configFile,
          worktree,
          ...(available === undefined ? {} : { availableModels: available }),
        });
        applied = {
          assignments: resolved.assignments,
          ...(typeof target.model === "string"
            ? { configuredModel: target.model }
            : {}),
          configuredProviders: isRecord(target.provider)
            ? Object.keys(target.provider)
            : [],
        };
        publishReport(target, options, resolved.report);
      } catch (error) {
        try {
          applied = { assignments: [], configuredProviders: [] };
          stripModelRefs(target);
          publishReport(target, options, {
            version: 1,
            configFile,
            selectionFile: selectionFilePath(stateDirectory(), worktree),
            worktree,
            profiles: [],
            profile: null,
            profileSource: "none",
            refs: [],
            notices: [
              `Model refs were not applied (${error instanceof Error ? error.message : String(error)}); agents keep OpenCode's models.`,
            ],
          });
        } catch {
          // A failing config hook must never stop OpenCode; agents then keep OpenCode's models.
        }
      }
    },
    "chat.message": async (_input, output) => {
      try {
        await fallbacks.message(output.message);
      } catch {
        // A failed check leaves the prompt as OpenCode built it.
      }
    },
    event: ({ event }) => {
      if (event.type === "session.idle") {
        fallbacks.idle();
      }
      return Promise.resolve();
    },
  });
};

export default {
  id: "model-profiles",
  server: ModelProfilesServer,
} satisfies PluginModule;
