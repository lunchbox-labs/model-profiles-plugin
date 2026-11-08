import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import {
  modelsFilePath,
  resolveModelProfiles,
  stripModelRefs,
} from "./apply.ts";
import {
  assignmentsAreStale,
  availabilityKey,
  availableModels,
  fallbackModel,
  knownAvailableModels,
  knownRefModels,
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
const toastTitle = "Model Profiles";

interface Applied {
  assignments: RefAssignment[];
  configuredModel?: string;
  configuredProviders: string[];
}

interface MessageInput {
  sessionID?: unknown;
  /** Set when the caller chose the model; unset when OpenCode took it from the agent or the session. */
  model?: unknown;
}

/** Availability each directory was last reloaded for, so a reload that changes nothing is never repeated. */
const reloadedFor = new Map<string, string>();

/** Fallback toasts already shown, per directory, so each one appears once per OpenCode process. */
const toastedFallbacks = new Set<string>();

function modelName(value: unknown): string | undefined {
  if (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    typeof value.modelID === "string"
  ) {
    return `${value.providerID}/${value.modelID}`;
  }
  // OpenCode stores a session's model as { providerID, id }.
  if (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    typeof value.id === "string"
  ) {
    return `${value.providerID}/${value.id}`;
  }
  return undefined;
}

/**
 * Keeps agents usable when a ref names a model no connected provider offers. The config hook runs before
 * providers load, so it cannot check models itself: it uses the availability saved by an earlier check, and until
 * there is one, a prompt to such a model is moved to the model OpenCode would use without the ref. When the
 * applied refs no longer match what is available, the project reloads once nothing is running, so the config hook
 * leaves those refs unapplied (which also covers built-in agents such as compaction that never pass through a
 * prompt).
 */
function createFallbacks(input: PluginInput, getApplied: () => Applied) {
  const { client, directory } = input;
  /** Each session's model after this hook, for subagents that inherit their parent's. */
  const sessionModels = new Map<string, string>();
  let reloadWanted = false;
  let reloading = false;
  let checkedOnce = false;
  let lastAvailable: ReadonlySet<string> | undefined;

  const log = (message: string) =>
    client.app
      .log({
        body: { service: logService, level: "warn", message },
        query: { directory },
      })
      .catch(() => undefined);

  /** Toasts a fallback in any client that shows OpenCode's toasts, since a log line alone goes unseen, and logs it. */
  const reportFallback = async (message: string) => {
    const toastKey = `${directory}\n${message}`;
    if (toastedFallbacks.has(toastKey)) {
      return;
    }
    toastedFallbacks.add(toastKey);
    Promise.resolve()
      .then(() =>
        client.tui.showToast({
          body: {
            title: toastTitle,
            message,
            variant: "warning",
            duration: 10_000,
          },
          query: { directory },
        }),
      )
      .catch(() => undefined);
    await log(message);
  };

  const check = async () => {
    const response = await client.config.providers({ query: { directory } });
    const connected =
      response.error === undefined
        ? readConnectedProviders(response.data)
        : undefined;
    if (connected === undefined) {
      return undefined;
    }
    const available = availableModels(connected);
    lastAvailable = available;
    await rememberAvailableModels(
      stateDirectory(),
      directory,
      available,
      getApplied().assignments.map((assignment) => assignment.model),
    );
    if (
      assignmentsAreStale(getApplied().assignments, available) &&
      reloadedFor.get(directory) !== availabilityKey(available)
    ) {
      reloadWanted = true;
    }
    return { connected, available };
  };

  const parentModel = async (sessionID: string) => {
    const session = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
    const parentID = isRecord(session.data) ? session.data.parentID : undefined;
    if (typeof parentID !== "string") {
      return undefined;
    }
    const remembered = sessionModels.get(parentID);
    if (remembered !== undefined) {
      return remembered;
    }
    const parent = await client.session.get({
      path: { id: parentID },
      query: { directory },
    });
    // OpenCode 1.19 includes the session's model, which the SDK's type does not list yet.
    const data: unknown = parent.data;
    return isRecord(data) ? modelName(data.model) : undefined;
  };

  const checkMessage = async (
    hookInput: MessageInput,
    message: Record<string, unknown>,
  ) => {
    const applied = getApplied();
    const requested = modelName(message.model);
    const sessionID =
      typeof hookInput.sessionID === "string" ? hookInput.sessionID : undefined;
    const result = await check();
    if (result === undefined || requested === undefined) {
      return;
    }
    const { connected, available } = result;
    const remember = (model: string) => {
      if (sessionID !== undefined) {
        sessionModels.set(sessionID, model);
      }
    };
    const agent =
      typeof message.agent === "string" ? message.agent : "the agent";
    if (available.has(requested)) {
      remember(requested);
      const unapplied = applied.assignments.find(
        (candidate) =>
          candidate.agent === message.agent &&
          !candidate.applied &&
          candidate.model !== requested &&
          !available.has(candidate.model),
      );
      if (unapplied !== undefined) {
        await reportFallback(
          `Ref "${unapplied.ref}" uses ${unapplied.model}, which no connected provider offers; ${agent} uses ${requested} instead.`,
        );
      }
      return;
    }
    // A model the caller chose (as the task tool does for a subagent) is moved only when a ref put it there. One
    // OpenCode took from the agent or the session is moved either way, because OpenCode stores a session's model
    // before this hook runs, so a session keeps asking for it after the ref is fixed or left out.
    const assignment =
      applied.assignments.find(
        (candidate) =>
          candidate.agent === message.agent && candidate.model === requested,
      ) ??
      applied.assignments.find((candidate) => candidate.model === requested);
    if (
      assignment === undefined &&
      (hookInput.model !== undefined ||
        !knownRefModels(directory).has(requested))
    ) {
      return;
    }
    const own =
      assignment !== undefined &&
      assignment.agent === message.agent &&
      assignment.ownModel !== undefined
        ? {
            model: assignment.ownModel,
            ...(assignment.ownVariant === undefined
              ? {}
              : { variant: assignment.ownVariant }),
          }
        : undefined;
    const inherited =
      sessionID === undefined
        ? undefined
        : await parentModel(sessionID).catch(() => undefined);
    const fallback = fallbackModel({
      ...(own === undefined ? {} : { own }),
      ...(inherited === undefined ? {} : { parentModel: inherited }),
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
    remember(`${fallback.providerID}/${fallback.modelID}`);
    await reportFallback(
      assignment === undefined
        ? `${agent} asked for ${requested}, which no connected provider offers; it uses ${fallback.providerID}/${fallback.modelID} instead.`
        : `Ref "${assignment.ref}" uses ${requested}, which no connected provider offers; ${agent} uses ${fallback.providerID}/${fallback.modelID} instead.`,
    );
  };

  /** Reloads only while no session is busy and no terminal is open, since a reload ends running terminals. */
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
    const terminals = await client.pty.list({ query: { directory } });
    if (
      terminals.error !== undefined ||
      !Array.isArray(terminals.data) ||
      terminals.data.length > 0
    ) {
      return;
    }
    const available = lastAvailable;
    const disposed = await client.instance.dispose({ query: { directory } });
    if (disposed.error === undefined) {
      reloadWanted = false;
      if (available !== undefined) {
        reloadedFor.set(directory, availabilityKey(available));
      }
    }
  };

  const scheduleReload = () => {
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
  };

  return {
    message: async (hookInput: MessageInput, message: unknown) => {
      if (isRecord(message)) {
        await checkMessage(hookInput, message);
      }
    },
    forget: (sessionID: string) => {
      sessionModels.delete(sessionID);
    },
    event: (type: string) => {
      if (!checkedOnce) {
        // Saves availability before the first prompt too, so the next start leaves unavailable refs out. Reloading
        // waits for an idle session, since the project may still be starting.
        checkedOnce = true;
        setTimeout(() => {
          check().catch(() => undefined);
        }, 0);
      }
      if (type === "session.idle") {
        scheduleReload();
      }
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
        const available = await knownAvailableModels(
          stateDirectory(),
          input.directory,
        );
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
    "chat.message": async (hookInput, output) => {
      try {
        await fallbacks.message(hookInput, output.message);
      } catch {
        // A failed check leaves the prompt as OpenCode built it.
      }
    },
    event: ({ event }) => {
      try {
        fallbacks.event(event.type);
        if (event.type === "session.deleted") {
          fallbacks.forget(event.properties.info.id);
        }
      } catch {
        // Fallback checks never stop OpenCode's events.
      }
      return Promise.resolve();
    },
  });
};

export default {
  id: "model-profiles",
  server: ModelProfilesServer,
} satisfies PluginModule;
