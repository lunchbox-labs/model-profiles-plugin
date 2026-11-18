import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  TuiDialogAlertProps,
  TuiDialogSelectProps,
} from "@opencode-ai/plugin/tui";
import {
  type ModelProfilesReport,
  applyModelRefs,
  createTuiPlugin,
  modelRefOptions,
  parseModelsDocument,
  publishReport,
  readReport,
} from "@lunchbox-labs/model-profiles-core";
import { host as opencode } from "../src/host.ts";
import { host as kilo } from "../../kilo/src/host.ts";

const models = JSON.stringify({
  defaults: {
    coding: {
      model: "custom/family/model",
      variant: "high",
      temperature: 0,
      top_p: 0.8,
      arbitrary: {
        enabled: false,
        count: 0,
        choices: ["a", "b"],
        missing: null,
        apiKey: "PRIVATE",
      },
      store: false,
      empty: "",
      headers: {
        Authorization: "PRIVATE",
        "X-Auth-Token": "PRIVATE",
        "X-Amz-Security-Token": "PRIVATE",
      },
      sessionToken: "PRIVATE",
      budgetTokens: 16000,
    },
  },
});

for (const host of [opencode, kilo]) {
  test(`${host.name} reports and displays every ref parameter without changing model options`, () => {
    const { document } = parseModelsDocument(host, models, "models.jsonc");
    const applied = applyModelRefs(
      host,
      { builder: { modelRef: "coding" }, helper: { modelRef: "coding" } },
      document,
      null,
    );
    const config = { plugin: [host.packageName] };
    const report: ModelProfilesReport = {
      version: 1,
      configFile: "models.jsonc",
      selectionFile: "selection.json",
      worktree: "/project",
      profiles: [],
      profile: null,
      profileSource: "none",
      refs: applied.refs,
      notices: [],
    };
    publishReport(host, config, undefined, report);
    const ref = readReport(config)?.refs[0];
    assert.ok(ref !== undefined);
    const options = modelRefOptions(host, ref);
    const value = (title: string) =>
      options.find((option) => option.title === title)?.description;
    assert.equal(value("Provider"), "custom");
    assert.equal(value("Model"), "family/model");
    assert.equal(value("Agents"), "builder, helper");
    assert.equal(value("variant"), '"high"');
    assert.equal(value("temperature"), "0");
    assert.equal(value("top_p"), "0.8");
    assert.equal(value("options.store"), "false");
    assert.equal(value("options.empty"), '""');
    assert.equal(value("options.sessionToken"), '"[redacted]"');
    assert.equal(value("options.budgetTokens"), "16000");
    assert.deepEqual(JSON.parse(value("options.arbitrary")!), {
      enabled: false,
      count: 0,
      choices: ["a", "b"],
      missing: null,
      apiKey: "[redacted]",
    });
    assert.ok(!JSON.stringify(config).includes("PRIVATE"));
    assert.ok(
      JSON.stringify(applied.agents).includes("PRIVATE"),
      "redaction only affects the report",
    );
    const old = modelRefOptions(host, {
      ref: "old",
      model: "custom/old",
      variant: "high",
      settings: ["temperature"],
      source: "defaults",
      agents: [],
    });
    assert.match(
      old.find((option) => option.title === "temperature")?.description ?? "",
      /not reported/,
    );
    const unresolved = modelRefOptions(host, {
      ref: "missing",
      source: "unresolved",
      agents: ["helper"],
    });
    assert.match(
      unresolved.find((option) => option.title === "Status")?.description ?? "",
      /Fallback/,
    );
    assert.match(
      modelRefOptions(host, ref, [{ id: "other", models: {} }]).find(
        (option) => option.title === "Status",
      )?.description ?? "",
      /Fallback/,
    );
  });

  test(
    `${host.name} ref details support Back, Escape, full values and disposal`,
    { timeout: 5000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "model-ref-details-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, "models.jsonc"), models);
      const { document } = parseModelsDocument(host, models, "models.jsonc");
      const report: ModelProfilesReport = {
        version: 1,
        configFile: join(root, "models.jsonc"),
        selectionFile: join(root, "selection.json"),
        worktree: root,
        profiles: [],
        profile: null,
        profileSource: "none",
        refs: applyModelRefs(
          host,
          { builder: { modelRef: "coding" } },
          document,
          null,
        ).refs,
        notices: [],
      };
      type View =
        | { kind: "menu"; props: TuiDialogSelectProps<string> }
        | { kind: "alert"; props: TuiDialogAlertProps };
      let view: View | undefined;
      let onClose: (() => void) | undefined;
      let onRender: (() => void) | undefined;
      let run: (() => void | Promise<void>) | undefined;
      const disposers: (() => void)[] = [];
      const controller = new AbortController();
      let pendingRead: Promise<void> | undefined;
      let pendingViewer: Promise<void> | undefined;
      let viewerFails = false;
      const toasts: string[] = [];
      const close = () => {
        const callback = onClose;
        onClose = undefined;
        callback?.();
        view = undefined;
      };
      const api = {
        state: {
          path: { directory: root, worktree: root },
          provider: [{ id: "custom", models: { "family/model": {} } }],
        },
        client: {
          config: {
            get: async () => {
              await pendingRead;
              return {
                data: {
                  plugin: [[host.packageName, { modelProfilesReport: report }]],
                },
              };
            },
          },
        },
        keymap: {
          registerLayer: (layer: {
            commands: { run: () => void | Promise<void> }[];
          }) => {
            run = layer.commands[0]?.run;
            return () => {};
          },
        },
        event: { on: () => () => {} },
        lifecycle: {
          signal: controller.signal,
          onDispose: (dispose: () => void) => {
            disposers.push(dispose);
            return () => {};
          },
        },
        ui: {
          toast: ({ message }: { message: string }) => toasts.push(message),
          dialog: {
            get open() {
              return view !== undefined;
            },
            replace: (render: () => void, callback?: () => void) => {
              close();
              onClose = callback;
              render();
              onRender?.();
            },
            clear: close,
            setSize: () => {},
          },
          DialogSelect: (props: TuiDialogSelectProps<string>) => {
            view = { kind: "menu", props };
          },
          DialogAlert: (props: TuiDialogAlertProps) => {
            view = { kind: "alert", props };
          },
        },
      };
      const dispose = () => disposers.splice(0).forEach((stop) => stop());
      t.after(dispose);
      await createTuiPlugin(host, () => {
        const render = (title: string, message: string) => {
          api.ui.DialogAlert({ title, message });
          return undefined as never;
        };
        return viewerFails
          ? Promise.reject(new Error("Unavailable renderer"))
          : pendingViewer === undefined
            ? Promise.resolve(render)
            : pendingViewer.then(() => render);
      }).tui(api as never, undefined, {} as never);
      const open = async () => {
        const rendered = new Promise<void>((resolve) => {
          onRender = resolve;
        });
        await run?.();
        await rendered;
        onRender = undefined;
      };
      const menu = () => {
        assert.ok(view?.kind === "menu");
        return view.props;
      };
      const alert = () => {
        assert.ok(view?.kind === "alert");
        return view.props;
      };
      const select = (value: string) => {
        const props = menu();
        const option = props.options.find((item) => item.value === value);
        assert.ok(option !== undefined, value);
        props.onSelect?.(option);
      };
      await open();
      const staleMain = menu();
      select("ref:coding");
      staleMain.onSelect?.(
        staleMain.options.find((option) => option.value === "defaults")!,
      );
      assert.equal(menu().title, "Model ref: coding");
      const parameter = menu().options.find(
        (option) => option.title === "options.arbitrary",
      );
      assert.ok(parameter !== undefined);
      select(parameter.value);
      await Promise.resolve();
      assert.ok(view?.kind === "alert");
      assert.match(view.props.message, /"enabled": false/);
      close();
      await Promise.resolve();
      assert.equal(menu().current, parameter.value);
      select("back");
      assert.equal(menu().current, "ref:coding");
      select("ref:coding");
      close();
      await Promise.resolve();
      assert.equal(menu().title, "Model config");
      select("ref:coding");
      let releaseViewer: (() => void) | undefined;
      pendingViewer = new Promise<void>((resolve) => {
        releaseViewer = resolve;
      });
      select(parameter.value);
      assert.match(alert().message, /Loading/);
      close();
      await Promise.resolve();
      assert.equal(menu().title, "Model ref: coding");
      releaseViewer?.();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        menu().title,
        "Model ref: coding",
        "cancelled imports do not reopen values",
      );
      pendingViewer = undefined;
      viewerFails = true;
      select(parameter.value);
      await Promise.resolve();
      assert.equal(menu().title, "Model ref: coding");
      assert.ok(toasts.some((message) => message.includes("retry")));
      viewerFails = false;
      select(parameter.value);
      await Promise.resolve();
      assert.match(alert().message, /"enabled": false/);
      close();
      await Promise.resolve();
      const wrongProject = menu();
      api.state.path.directory = `${root}/other`;
      wrongProject.onSelect?.(
        wrongProject.options.find((option) => option.value === "back")!,
      );
      assert.equal(menu(), wrongProject, "stale project callbacks are ignored");
      close();
      await Promise.resolve();
      assert.equal(view, undefined);
      api.state.path.directory = root;
      await open();
      close();
      await Promise.resolve();
      assert.equal(view, undefined);
      let releaseRead: (() => void) | undefined;
      pendingRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const opening = run?.();
      api.ui.DialogAlert({
        title: "Another extension",
        message: "Keep this view",
      });
      releaseRead?.();
      await opening;
      assert.equal(alert().title, "Another extension");
      close();
      pendingRead = undefined;
      await open();
      select("ref:coding");
      const staleRef = menu();
      close();
      controller.abort();
      await Promise.resolve();
      assert.equal(
        view,
        undefined,
        "abort invalidates the view before onDispose callbacks run",
      );
      dispose();
      staleRef.onSelect?.(
        staleRef.options.find((option) => option.value === "back")!,
      );
      await Promise.resolve();
      assert.equal(
        view,
        undefined,
        "disposing prevents a queued return from reopening the dialog",
      );
    },
  );
}
