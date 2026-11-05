import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import {
  modelConfigOptions,
  profileLabel,
  selectedProfile,
} from "./model-config-view.ts";
import { loadModelsDocument } from "./models-file.ts";
import { type ModelProfilesReport, readReport } from "./report.ts";
import { processProfileVariable, saveSelection } from "./selection.ts";

const toastTitle = "Model Profiles";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerModelConfig(api: TuiPluginApi): void {
  const directory = () => api.state.path.directory;
  let shownNotices = new Set<string>();
  let reading: Promise<unknown> = Promise.resolve();
  let reloading = false;

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
    { report: ModelProfilesReport; newNotices: string[] } | undefined
  > => {
    const next = reading.then(async () => {
      const response = await api.client.config.get({ directory: directory() });
      const report =
        response.error === undefined ? readReport(response.data) : undefined;
      if (report === undefined) {
        return undefined;
      }
      const newNotices = report.notices.filter(
        (notice) => !shownNotices.has(notice),
      );
      shownNotices = new Set(report.notices);
      return { report, newNotices };
    });
    reading = next.catch(() => undefined);
    return next;
  };

  const announceFallbacks = async () => {
    const applied = await readApplied();
    if (applied !== undefined && applied.newNotices.length > 0) {
      toast("warning", applied.newNotices);
    }
  };

  const reload = async (label: string) => {
    const status = await api.client.session.status({ directory: directory() });
    const busy =
      status.error !== undefined ||
      Object.values(status.data).some((session) => session.type !== "idle");
    if (busy) {
      toast("info", [
        `Saved ${label} for this worktree. A session is busy, so it applies the next time OpenCode reloads this project.`,
      ]);
      return;
    }
    reloading = true;
    const disposed = await api.client.instance
      .dispose({ directory: directory() })
      .finally(() => {
        reloading = false;
      });
    if (disposed.error !== undefined) {
      toast("warning", [
        `Saved ${label}, but OpenCode did not reload. It applies on the next reload.`,
      ]);
      return;
    }
    const applied = await readApplied();
    if (applied === undefined) {
      toast("success", [`Saved ${label}.`]);
      return;
    }
    toast(applied.newNotices.length > 0 ? "warning" : "success", [
      `Using ${profileLabel(applied.report.profile)}.`,
      ...applied.newNotices,
    ]);
  };

  const choose = async (
    report: ModelProfilesReport,
    profile: string | null,
  ) => {
    const label = profileLabel(profile);
    try {
      await saveSelection(report.selectionFile, report.worktree, profile);
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
    const report = (await readApplied().catch(() => undefined))?.report;
    if (report === undefined) {
      toast("warning", [
        "The server plugin has not reported model refs. Add @lunchbox-labs/opencode-model-profiles to plugin in opencode.jsonc.",
      ]);
      return;
    }
    const current = await loadModelsDocument(report.configFile);
    const profiles =
      current.status === "loaded"
        ? Object.keys(current.document.profiles)
        : report.profiles;
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Model config",
        options: modelConfigOptions(report, profiles),
        current:
          report.profile === null ? "defaults" : `profile:${report.profile}`,
        onSelect: (option) => {
          const profile = selectedProfile(option.value);
          if (profile === undefined) {
            return;
          }
          api.ui.dialog.clear();
          choose(report, profile).catch(() => undefined);
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
  const unsubscribe = api.event.on("server.instance.disposed", (event) => {
    if (!reloading && event.properties.directory === directory()) {
      announceFallbacks().catch(() => undefined);
    }
  });
  api.lifecycle.onDispose(() => {
    unregister();
    unsubscribe();
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
