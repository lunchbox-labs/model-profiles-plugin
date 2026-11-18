import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import type { Host } from "./host.ts";
import type { ValueViewer, ValueViewerLoader } from "./value-view.ts";
import {
  type ModelConfigChoice,
  fallbackToastLines,
  modelConfigOptions,
  modelRefOptions,
  profileLabel,
  selectedChoice,
  selectedNotice,
  unavailableModelNotices,
} from "./model-config-view.ts";
import { loadModelsDocument } from "./models-file.ts";
import { type ModelProfilesReport, readReport } from "./report.ts";
import {
  clearSelection,
  readSavedSelection,
  saveSelection,
} from "./selection.ts";

const toastTitle = "Model Profiles";
const pendingPickDelay = 750;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerModelConfig(
  host: Host,
  api: TuiPluginApi,
  loadValueViewer?: ValueViewerLoader,
): void {
  const directory = () => api.state.path.directory;
  let shownNotices = new Set<string>();
  let reading: Promise<unknown> = Promise.resolve();
  let reloadsInFlight = 0;
  let viewRevision = 0;
  let disposed = false;

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
        ...unavailableModelNotices(host, report.refs, api.state.provider),
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
  let pendingPickRetryRequested = false;
  const hasPendingPick = () => pendingPick !== undefined;
  const takePendingPickRetry = () => {
    const requested = pendingPickRetryRequested;
    pendingPickRetryRequested = false;
    return requested;
  };

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
        `Saved ${label}, but ${host.name} did not reload. It applies on the next reload.`,
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
          `Saved ${label} for this worktree, but ${host.name} could not report whether a session is busy, so it did not reload. It applies on the next reload.`,
        ]);
        return;
      case "unknownTerminals":
        toast("warning", [
          `Saved ${label} for this worktree, but ${host.name} could not report whether a terminal is open, so it did not reload. It applies on the next reload.`,
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

  const applyPendingPick = async (): Promise<void> => {
    if (!hasPendingPick()) {
      return;
    }
    if (applyingPendingPick) {
      // The attempt in flight may have read a blocker this event just cleared, so it runs again afterwards.
      pendingPickRetryRequested = true;
      return;
    }
    applyingPendingPick = true;
    takePendingPickRetry();
    try {
      // The server plugin's own fallback reload reacts to the same events; waiting lets its disposal apply the pick.
      await new Promise((resolve) => setTimeout(resolve, pendingPickDelay));
      if (!hasPendingPick() || (await reloadBlocker()) !== undefined) {
        return;
      }
      const label = takePendingPick();
      if (label !== undefined) {
        await disposeFor(label);
      }
    } finally {
      applyingPendingPick = false;
      // A refused reload has taken the pick, so a rerun goes ahead only for a pick still held back by a blocker.
      if (takePendingPickRetry()) {
        applyPendingPick().catch(() => undefined);
      }
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
        `Saved ${label} for this worktree. ${host.variables.profile}=${report.environmentProfile} still applies to this ${host.name} process.`,
      ]);
      return;
    }
    try {
      await reload(label);
    } catch (error) {
      toast("warning", [
        `Saved ${label}, but could not reload ${host.name} (${errorText(error)}). It applies on the next reload.`,
      ]);
    }
  };

  const open = async () => {
    const requested = ++viewRevision;
    const client = api.client;
    const project = directory();
    const sameProject = () =>
      !disposed &&
      !api.lifecycle.signal.aborted &&
      client === api.client &&
      project === directory();
    const isCurrent = (revision: number) =>
      revision === viewRevision && sameProject();
    const applied = await readApplied().catch(() => undefined);
    if (!isCurrent(requested)) {
      return;
    }
    if (applied === undefined) {
      toast("warning", [
        `The server plugin has not reported model refs. Add ${host.packageName} to plugin in ${host.configFile}.`,
      ]);
      return;
    }
    const { report, notices } = applied;
    const [current, saved] = await Promise.all([
      loadModelsDocument(host, report.configFile),
      readSavedSelection(report.selectionFile),
    ]);
    if (!isCurrent(requested) || api.ui.dialog.open) {
      return;
    }
    const loaded = current.status === "loaded";
    const defaultProfile = loaded ? current.document.defaultProfile : undefined;
    type Render = Parameters<typeof api.ui.dialog.replace>[0];
    const show = (render: Render, back?: () => void) => {
      if (!sameProject()) {
        return;
      }
      const active = ++viewRevision;
      api.ui.dialog.replace(render, () => {
        if (active !== viewRevision) {
          return;
        }
        const closed = ++viewRevision;
        if (back !== undefined) {
          queueMicrotask(() => {
            if (
              closed === viewRevision &&
              sameProject() &&
              !api.ui.dialog.open
            ) {
              back();
            }
          });
        }
      });
      api.ui.dialog.setSize("large");
    };
    const views = {
      value: async (
        ref: ModelProfilesReport["refs"][number],
        option: { title: string; value: string; description?: string },
      ) => {
        if (loadValueViewer !== undefined) {
          show(
            () =>
              api.ui.DialogAlert({
                title: option.title,
                message: "Loading value…",
              }),
            () => views.ref(ref, option.value),
          );
        }
        const active = viewRevision;
        let render: ValueViewer;
        try {
          render =
            loadValueViewer === undefined
              ? (title, message) => api.ui.DialogAlert({ title, message })
              : await loadValueViewer(api);
        } catch {
          if (isCurrent(active)) {
            views.ref(ref, option.value);
            toast("warning", [
              "Could not open this value; select the row to retry.",
            ]);
          }
          return;
        }
        if (!isCurrent(active)) {
          return;
        }
        show(
          () =>
            render(
              option.title,
              option.value.startsWith("parameter:")
                ? JSON.stringify(
                    JSON.parse(option.description ?? "null") as unknown,
                    null,
                    2,
                  )
                : (option.description ?? ""),
            ),
          () => views.ref(ref, option.value),
        );
      },
      ref: (ref: ModelProfilesReport["refs"][number], selected?: string) => {
        show(
          () => {
            const active = viewRevision;
            return api.ui.DialogSelect({
              title: `Model ref: ${ref.ref}`,
              options: modelRefOptions(host, ref, api.state.provider),
              current: selected,
              onSelect: (option) => {
                if (!isCurrent(active)) {
                  return;
                }
                if (option.value === "back") {
                  views.main(`ref:${ref.ref}`);
                } else if (option.description !== undefined) {
                  views
                    .value(ref, option)
                    .catch(() =>
                      toast("warning", [
                        "Could not open this value; select the row to retry.",
                      ]),
                    );
                }
              },
            });
          },
          () => views.main(`ref:${ref.ref}`),
        );
      },
      main: (selected?: string) =>
        show(() => {
          const active = viewRevision;
          return api.ui.DialogSelect({
            title: "Model config",
            options: modelConfigOptions(host, {
              report,
              profiles: loaded
                ? Object.keys(current.document.profiles)
                : report.profiles,
              savedProfile: saved.profile,
              defaultProfile,
              notices,
            }),
            current:
              selected ??
              (report.profile === null
                ? "defaults"
                : `profile:${report.profile}`),
            onSelect: (option) => {
              if (!isCurrent(active)) {
                return;
              }
              const notice = selectedNotice(option.value, notices);
              if (notice !== undefined) {
                toast("warning", [notice]);
                return;
              }
              if (option.value.startsWith("ref:")) {
                const ref = report.refs.find(
                  (entry) => entry.ref === option.value.slice(4),
                );
                if (ref !== undefined) {
                  views.ref(ref);
                }
                return;
              }
              const choice = selectedChoice(option.value);
              if (choice === undefined) {
                return;
              }
              viewRevision++;
              api.ui.dialog.clear();
              choose(report, choice, defaultProfile).catch(() => undefined);
            },
          });
        }),
    };
    views.main();
  };

  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "model-profiles.config",
        title: "Model config",
        category: "Model",
        namespace: "palette",
        slashName: "model-config",
        run: () => open().catch(() => undefined),
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
    disposed = true;
    viewRevision++;
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

/**
 * The TUI plugin for a host: the `./tui` export of its package. Its type is the one the OpenCode package has always
 * declared, which fits the host's TuiPluginModule.
 */
export function createTuiPlugin(
  host: Host,
  loadValueViewer?: ValueViewerLoader,
): { id: string; tui: TuiPlugin } {
  const tui: TuiPlugin = (api) => {
    registerModelConfig(host, api, loadValueViewer);
    return Promise.resolve();
  };
  return { id: "model-profiles", tui } satisfies TuiPluginModule;
}
