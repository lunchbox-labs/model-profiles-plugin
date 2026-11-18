import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type * as OpenTui from "@opentui/core";
import type * as OpenTuiTesting from "@opentui/core/testing";
import { createValueViewer } from "../packages/core/src/value-view.ts";

for (const host of ["opencode", "kilo"]) {
  test(
    `${host} parameter values scroll, resize and clean up with the native renderer`,
    { timeout: 15000 },
    async (t) => {
      const require = createRequire(
        new URL(`../packages/${host}/package.json`, import.meta.url),
      );
      const runtime = (await import(
        require
          .resolve("@opentui/core")
          .replace("index.node.js", "index.bun.js")
      )) as typeof OpenTui;
      const { createTestRenderer } = (await import(
        require
          .resolve("@opentui/core/testing")
          .replace("testing.js", "testing.bun.js")
      )) as typeof OpenTuiTesting;
      const rendered = await createTestRenderer({ width: 88, height: 30 });
      const { renderer } = rendered;
      const controller = new AbortController();
      const layers = new Set<{
        bindings?: { key: string; cmd: () => void }[];
      }>();
      const api = {
        renderer,
        theme: {
          current: {
            text: runtime.RGBA.fromHex("#e5e7eb"),
            textMuted: runtime.RGBA.fromHex("#94a3b8"),
          },
        },
        lifecycle: { signal: controller.signal },
        keymap: {
          registerLayer: (layer: {
            bindings?: { key: string; cmd: () => void }[];
          }) => {
            layers.add(layer);
            return () => layers.delete(layer);
          },
        },
      } as unknown as TuiPluginApi;
      const initialResizeListeners = renderer.listenerCount("resize");
      const message = JSON.stringify(
        {
          enabled: false,
          budgetTokens: 0,
          records: Array.from({ length: 80 }, (_, index) => `row-${index}`),
          last: "END_OF_PARAMETER",
        },
        null,
        2,
      );
      const view = createValueViewer(api, runtime)(
        "options.arbitrary",
        message,
      );
      assert.ok(view instanceof runtime.BoxRenderable);
      renderer.root.add(view);
      t.after(() => {
        controller.abort();
        renderer.destroy();
      });
      await rendered.flush();
      assert.match(rendered.captureCharFrame(), /row-0/);
      assert.doesNotMatch(rendered.captureCharFrame(), /END_OF_PARAMETER/);
      const output = process.env.MODEL_VIEW_ARTIFACT_DIR;
      const capture = async (name: string) => {
        if (output !== undefined) {
          await mkdir(output, { recursive: true });
          const frame = rendered.captureSpans();
          await writeFile(
            join(output, `${host}-${name}.json`),
            JSON.stringify({
              cols: frame.cols,
              rows: frame.rows,
              lines: frame.lines.map((line) =>
                line.spans.map((span) => ({
                  text: span.text,
                  width: span.width,
                  fg: span.fg.toInts(),
                  bg: span.bg.toInts(),
                })),
              ),
            }),
          );
        }
      };
      await capture("value-top");
      const end = [...layers][0]?.bindings?.find(
        (binding) => binding.key === "end",
      );
      assert.ok(end !== undefined);
      end.cmd();
      await rendered.flush();
      assert.match(rendered.captureCharFrame(), /END_OF_PARAMETER/);
      await capture("value-end");
      rendered.resize(52, 18);
      await rendered.flush();
      end.cmd();
      await rendered.flush();
      assert.match(rendered.captureCharFrame(), /END_OF_PARAMETER/);
      view.destroyRecursively();
      assert.equal(layers.size, 0);
      assert.equal(renderer.listenerCount("resize"), initialResizeListeners);
      const next = createValueViewer(api, runtime)("Next value", message);
      assert.ok(next instanceof runtime.BoxRenderable);
      renderer.root.add(next);
      controller.abort();
      assert.equal(next.isDestroyed, true);
      assert.equal(layers.size, 0);
      assert.equal(renderer.listenerCount("resize"), initialResizeListeners);
      assert.throws(
        () => createValueViewer(api, runtime)("Closed", message),
        /closed/,
      );
    },
  );
}
