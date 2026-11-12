import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const hostPackages = /^@(?:opencode-ai|kilocode|opentui)\/|^solid-js(?:\/|$)/;

test("the core depends on no host package at runtime", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.dependencies), ["jsonc-parser"]);
  const source = new URL("../src/", import.meta.url);
  let typeImports = 0;
  for (const file of await readdir(source)) {
    const text = await readFile(new URL(file, source), "utf8");
    for (const [, kind, specifier] of text.matchAll(
      /^import (type )?[^;]*? from "([^"]+)";/gm,
    )) {
      if (hostPackages.test(specifier)) {
        assert.equal(kind, "type ", `${file} imports ${specifier} at runtime`);
        typeImports += 1;
      }
    }
  }
  assert.ok(typeImports > 0, "the core takes its plugin types from OpenCode");
});
