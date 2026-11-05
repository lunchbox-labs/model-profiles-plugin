import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run package tests through npm");
const { devDependencies } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { devDependencies: Record<string, string> };

test(
  "packed plugin installs independently and exposes loadable server and TUI entries with declarations",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "model-profiles-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packed = await execute(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: resolve("."), timeout: 60_000, signal: t.signal },
    );
    const [{ filename, files }] = JSON.parse(packed.stdout) as {
      filename: string;
      files: { path: string }[];
    }[];
    const paths = files.map((file) => file.path);
    for (const path of [
      "dist/server.js",
      "dist/server.d.ts",
      "dist/tui.js",
      "dist/tui.d.ts",
      "README.md",
      "LICENSE",
      "package.json",
    ]) {
      assert.ok(paths.includes(path), `Missing ${path}`);
    }
    for (const path of paths) {
      assert.ok(
        path.startsWith("dist/") ||
          ["README.md", "LICENSE", "package.json"].includes(path),
        `Unexpected packed file: ${path}`,
      );
    }
    await execute(
      process.execPath,
      [
        npm,
        "install",
        "--prefix",
        root,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(root, filename),
        `@opencode-ai/plugin@${devDependencies["@opencode-ai/plugin"]}`,
        `@types/node@${devDependencies["@types/node"]}`,
      ],
      { timeout: 120_000, signal: t.signal },
    );
    await writeFile(
      join(root, "consumer.mjs"),
      `import assert from 'node:assert/strict';
import root from '@lunchbox-labs/opencode-model-profiles';
import server from '@lunchbox-labs/opencode-model-profiles/server';
import tui from '@lunchbox-labs/opencode-model-profiles/tui';
assert.equal(root, server, 'the root export is the server entry');
assert.equal(server.id, 'model-profiles');
assert.equal(typeof server.server, 'function');
assert.equal(Object.hasOwn(server, 'tui'), false);
assert.equal(typeof (await server.server({}, {})), 'object');
assert.equal(tui.id, 'model-profiles');
assert.equal(typeof tui.tui, 'function');
assert.equal(Object.hasOwn(tui, 'server'), false);
await tui.tui({}, undefined, {});
`,
    );
    await execute(process.execPath, [join(root, "consumer.mjs")], {
      cwd: root,
      timeout: 60_000,
      signal: t.signal,
    });
    await writeFile(
      join(root, "consumer.mts"),
      `import type { PluginModule } from '@opencode-ai/plugin';
import type { TuiPluginModule } from '@opencode-ai/plugin/tui';
import root from '@lunchbox-labs/opencode-model-profiles';
import server from '@lunchbox-labs/opencode-model-profiles/server';
import tui from '@lunchbox-labs/opencode-model-profiles/tui';
const rootModule: PluginModule = root;
const serverModule: PluginModule = server;
const tuiModule: TuiPluginModule = tui;
console.log(rootModule.id, serverModule.id, tuiModule.id);
`,
    );
    await execute(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--target",
        "ES2023",
        join(root, "consumer.mts"),
      ],
      { cwd: root, timeout: 60_000, signal: t.signal },
    );
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          "node_modules/@lunchbox-labs/opencode-model-profiles/package.json",
        ),
        "utf8",
      ),
    ) as Record<string, Record<string, string> | undefined>;
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.equal(Object.hasOwn(manifest.engines ?? {}, "opencode"), false);
    assert.equal(manifest.engines?.node, ">=22.18.0");
  },
);
