import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import {
  type ModelConfigChoice,
  fallbackToastLines,
  modelConfigOptions,
  profileLabel,
  selectedChoice,
  selectedNotice,
  unavailableModelNotices,
} from "./model-config-view.ts";
import { loadModelsDocument } from "./models-file.ts";
import { type ModelProfilesReport, readReport } from "./report.ts";
import {
  clearSelection,
  processProfileVariable,
  readSavedSelection,
  saveSelection,
} from "./selection.ts";

const toastTitle = "Model Profiles";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerModelConfig(api: TuiPluginApi): void {
  const directory = () => api.state.path.directory;
  let shownNotices = new Set<string>();
  let reading: Promise<unknown> = Promise.resolve();
  let reloadsInFlight = 0;

  const toast = (variant: "info" | "success" | "warning", lines: string[]) => {
    api.ui.toast({
      variant,
      title: toastTitle,
      message: lines.join("\n"),
      duration: variant === "warning" ? 10_000 : 5_000,
    });
  };

  /** Reads what the server applied; a fallback is new until it disappears from a later report. */
  const readApplied = (): Promise<
    | { report: ModelProfilesReport; notices: string[]; newNotices: string[] }
    | undefined
  > => {
    const next = reading.then(async () => {
      const response = await api.client.config.get({ directory: directory() });
      const report =
        response.error === undefined ? readReport(response.data) : undefined;
      if (report === undefined) {
        return undefined;
      }
      const notices = [
        ...unavailableModelNotices(report.refs, api.state.provider),
        ...report.notices,
      ];
      const newNotices = notices.filter((notice) => !shownNotices.has(notice));
      shownNotices = new Set(notices);
      return { report, notices, newNotices };
    });
    reading = next.catch(() => undefined);
    return next;
  };

  const announceFallbacks = async () => {
    const applied = await readApplied();
    if (applied !== undefined && applied.newNotices.length > 0) {
      toast("warning", fallbackToastLines(applied.newNotices));
    }
  };

  /** A pick saved while something was running, applied once nothing is; a reload would end running terminals. */
  let pendingPick: string | undefined;
  let applyingPendingPick = false;

  const reloadBlocker = async (): Promise<
    "unknownSessions" | "busy" | "unknownTerminals" | "terminal" | undefined
  > => {
    const status = await api.client.session.status({ directory: directory() });
    if (status.error !== undefined) {
      return "unknownSessions";
    }
    if (Object.values(status.data).some((session) => session.type !== "idle")) {
      return "busy";
    }
    const terminals = await api.client.pty.list({ directory: directory() });
    if (terminals.error !== undefined || !Array.isArray(terminals.data)) {
      return "unknownTerminals";
    }
    return terminals.data.length > 0 ? "terminal" : undefined;
  };

  const announceProfile = async (label: string) => {
    const applied = await readApplied();
    if (applied === undefined) {
      toast("success", [`Saved ${label}.`]);
      return;
    }
    toast(applied.newNotices.length > 0 ? "warning" : "success", [
      `Using ${profileLabel(applied.report.profile)}.`,
      ...fallbackToastLines(applied.newNotices),
    ]);
  };

  const disposeFor = async (label: string) => {
    reloadsInFlight += 1;
    const disposed = await api.client.instance
      .dispose({ directory: directory() })
      .finally(() => {
        reloadsInFlight -= 1;
      });
    if (disposed.error !== undefined) {
      toast("warning", [
        `Saved ${label}, but OpenCode did not reload. It applies on the next reload.`,
      ]);
      return;
    }
    await announceProfile(label);
  };

  const reload = async (label: string) => {
    pendingPick = undefined;
    const blocker = await reloadBlocker();
    switch (blocker) {
      case "unknownSessions":
        toast("warning", [
          `Saved ${label} for this worktree, but OpenCode could not report whether a session is busy, so it did not reload. It applies on the next reload.`,
        ]);
        return;
      case "unknownTerminals":
        toast("warning", [
          `Saved ${label} for this worktree, but OpenCode could not report whether a terminal is open, so it did not reload. It applies on the next reload.`,
        ]);
        return;
      case "busy":
        pendingPick = label;
        toast("info", [
          `Saved ${label} for this worktree. A session is busy, so it applies once no session is busy and no terminal is open.`,
        ]);
        return;
      case "terminal":
        pendingPick = label;
        toast("info", [
          `Saved ${label} for this worktree. Reloading would end the open terminals, so it applies once they are all closed.`,
        ]);
        return;
      case undefined:
        await disposeFor(label);
    }
  };

  /** Reads and clears the pending pick; a newer pick or another reload may have changed it meanwhile. */
  const takePendingPick = () => {
    const label = pendingPick;
    pendingPick = undefined;
    return label;
  };

  const applyPendingPick = async () => {
    if (pendingPick === undefined || applyingPendingPick) {
      return;
    }
    applyingPendingPick = true;
    try {
      if ((await reloadBlocker()) !== undefined) {
        return;
      }
      const label = takePendingPick();
      if (label !== undefined) {
        await disposeFor(label);
      }
    } finally {
      applyingPendingPick = false;
    }
  };

  const choose = async (
    report: ModelProfilesReport,
    choice: ModelConfigChoice,
    defaultProfile: string | undefined,
  ) => {
    const label =
      choice.kind === "save"
        ? profileLabel(choice.profile)
        : `defaultProfile (${defaultProfile ?? "none"})`;
    try {
      await (choice.kind === "save"
        ? saveSelection(report.selectionFile, report.worktree, choice.profile)
        : clearSelection(report.selectionFile));
    } catch (error) {
      toast("warning", [`Could not save ${label}: ${errorText(error)}`]);
      return;
    }
    if (report.environmentProfile !== undefined) {
      toast("info", [
        `Saved ${label} for this worktree. ${processProfileVariable}=${report.environmentProfile} still applies to this OpenCode process.`,
      ]);
      return;
    }
    try {
      await reload(label);
    } catch (error) {
      toast("warning", [
        `Saved ${label}, but could not reload OpenCode (${errorText(error)}). It applies on the next reload.`,
      ]);
    }
  };

  const open = async () => {
    const applied = await readApplied().catch(() => undefined);
    if (applied === undefined) {
      toast("warning", [
        "The server plugin has not reported model refs. Add @lunchbox-labs/opencode-model-profiles to plugin in opencode.jsonc.",
      ]);
      return;
    }
    const { report, notices } = applied;
    const [current, saved] = await Promise.all([
      loadModelsDocument(report.configFile),
      readSavedSelection(report.selectionFile),
    ]);
    const loaded = current.status === "loaded";
    const defaultProfile = loaded ? current.document.defaultProfile : undefined;
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Model config",
        options: modelConfigOptions({
          report,
          profiles: loaded
            ? Object.keys(current.document.profiles)
            : report.profiles,
          savedProfile: saved.profile,
          defaultProfile,
          notices,
        }),
        current:
          report.profile === null ? "defaults" : `profile:${report.profile}`,
        onSelect: (option) => {
          const notice = selectedNotice(option.value, notices);
          if (notice !== undefined) {
            toast("warning", [notice]);
            return;
          }
          const choice = selectedChoice(option.value);
          if (choice === undefined) {
            return;
          }
          api.ui.dialog.clear();
          choose(report, choice, defaultProfile).catch(() => undefined);
        },
      }),
    );
    api.ui.dialog.setSize("large");
  };

  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "model-profiles.config",
        title: "Model config",
        category: "Model",
        namespace: "palette",
        slashName: "model-config",
        run: () => {
          open().catch(() => undefined);
        },
      },
    ],
  });
  const unsubscribeInstance = api.event.on(
    "server.instance.disposed",
    (event) => {
      if (reloadsInFlight > 0 || event.properties.directory !== directory()) {
        return;
      }
      // Any reload of the project applies the saved pick, so a pending one no longer waits.
      const appliedPick = takePendingPick();
      (appliedPick === undefined
        ? announceFallbacks()
        : announceProfile(appliedPick)
      ).catch(() => undefined);
    },
  );
  const retryPendingPick = () => {
    applyPendingPick().catch(() => undefined);
  };
  const unsubscribeRetries = [
    api.event.on("session.idle", retryPendingPick),
    api.event.on("session.status", (event) => {
      if (event.properties.status.type === "idle") {
        retryPendingPick();
      }
    }),
    api.event.on("pty.exited", retryPendingPick),
    api.event.on("pty.deleted", retryPendingPick),
  ];
  const unsubscribeGlobal = api.event.on("global.disposed", () => {
    announceFallbacks().catch(() => undefined);
  });
  /** Models are checked against connected providers, which may not have loaded when the TUI starts. */
  let providerChecks = 0;
  const providerTimer = setInterval(() => {
    providerChecks += 1;
    if (api.state.provider.length > 0) {
      clearInterval(providerTimer);
      announceFallbacks().catch(() => undefined);
    } else if (providerChecks >= 60) {
      clearInterval(providerTimer);
    }
  }, 500);
  providerTimer.unref();
  api.lifecycle.onDispose(() => {
    clearInterval(providerTimer);
    unregister();
    unsubscribeInstance();
    unsubscribeGlobal();
    for (const unsubscribe of unsubscribeRetries) {
      unsubscribe();
    }
  });
  announceFallbacks().catch(() => undefined);
}

const ModelProfilesTui: TuiPlugin = (api) => {
  registerModelConfig(api);
  return Promise.resolve();
};

export default {
  id: "model-profiles",
  tui: ModelProfilesTui,
} satisfies TuiPluginModule;
