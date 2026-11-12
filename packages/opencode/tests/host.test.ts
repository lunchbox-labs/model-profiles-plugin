import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cacheDirectory,
  configurationDirectory,
  dataDirectory,
  modelsFilePath,
  parseModelsDocument,
  processProfile,
  providerSetupKey,
  stateDirectory,
} from "@lunchbox-labs/model-profiles-core";
import { host } from "../src/host.ts";

test("OpenCode's directories and profile override ignore Kilo's settings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    KILO_CONFIG_DIR: path.join(root, "kilo-config"),
    KILO_MODEL_PROFILE: "kilo",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
  };
  assert.equal(
    configurationDirectory(host, environment),
    path.join(environment.XDG_CONFIG_HOME, "opencode"),
  );
  assert.equal(processProfile(host, environment), undefined);
  // Kilo keeps using <data>/state once it exists; OpenCode does not.
  await mkdir(path.join(environment.XDG_DATA_HOME, "opencode", "state"), {
    recursive: true,
  });
  assert.notEqual(
    stateDirectory(host, environment),
    path.join(environment.XDG_DATA_HOME, "opencode", "state"),
  );
});

test("a configFile starting with ~ is in OpenCode's home directory", () => {
  const environment = {
    OPENCODE_CONFIG_DIR: path.resolve("/config/opencode"),
    OPENCODE_TEST_HOME: path.resolve("/test-home"),
    KILO_TEST_HOME: path.resolve("/kilo-home"),
  };
  assert.equal(
    modelsFilePath(host, { configFile: "~/models.jsonc" }, environment),
    path.resolve("/test-home/models.jsonc"),
  );
  assert.equal(
    modelsFilePath(host, { configFile: "models/work.jsonc" }, environment),
    path.resolve("/config/opencode/models/work.jsonc"),
  );
});

test("Kilo's agent names are not OpenCode built-ins", () => {
  const { document, notices } = parseModelsDocument(
    host,
    '{ "builtins": { "build": "coding", "code": "coding", "scout": "coding" } }',
    "models.jsonc",
  );
  assert.deepEqual(document.builtins, { build: "coding" });
  assert.equal(notices.length, 2);
});

test("the example names OpenCode's schema and parses without notices", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schema.json", import.meta.url), "utf8"),
  ) as { $id: string };
  assert.equal(
    schema.$id,
    "https://cdn.jsdelivr.net/npm/@lunchbox-labs/opencode-model-profiles/schema.json",
  );
  const example = await readFile(
    new URL("../examples/models.jsonc", import.meta.url),
    "utf8",
  );
  assert.ok(example.includes(`"$schema": "${schema.$id}"`));
  assert.deepEqual(
    parseModelsDocument(host, example, "models.jsonc").notices,
    [],
  );
});

test("OpenCode's XDG directories keep a stray line break, as OpenCode itself does", () => {
  const base = path.resolve("/xdg");
  assert.equal(
    configurationDirectory(host, { XDG_CONFIG_HOME: `${base}\n` }),
    path.join(`${base}\n`, "opencode"),
  );
  assert.equal(
    dataDirectory(host, { XDG_DATA_HOME: `${base}\r\n` }),
    path.join(`${base}\r\n`, "opencode"),
  );
  assert.equal(
    cacheDirectory(host, { XDG_CACHE_HOME: `${base}\r` }),
    path.join(`${base}\r`, "opencode"),
  );
  assert.equal(
    stateDirectory(host, { XDG_STATE_HOME: `${base}\n` }),
    path.join(`${base}\n`, "opencode"),
  );
});

test("the provider setup reads the catalog OpenCode caches for OPENCODE_MODELS_URL, and models.json without it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-models-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = { data: root, cache: root };
  const source = "https://catalog.example.invalid";
  const hash = createHash("sha1").update(source).digest("hex");
  await writeFile(
    path.join(root, "models.json"),
    JSON.stringify({ usual: { env: ["USUAL_CONNECTION"] } }),
  );
  await writeFile(
    path.join(root, `models-${hash}.json`),
    JSON.stringify({ custom: { env: ["CUSTOM_CONNECTION"] } }),
  );
  const changesWith = async (
    environment: NodeJS.ProcessEnv,
    variable: string,
  ): Promise<boolean> =>
    (await providerSetupKey(host, {}, environment, directories)) !==
    (await providerSetupKey(
      host,
      {},
      { ...environment, [variable]: "present" },
      directories,
    ));
  // Unset, empty or the default source all read models.json, as OpenCode does.
  for (const environment of [
    {},
    { OPENCODE_MODELS_URL: "" },
    { OPENCODE_MODELS_URL: "https://models.opencode.ai" },
  ]) {
    assert.equal(await changesWith(environment, "USUAL_CONNECTION"), true);
    assert.equal(await changesWith(environment, "CUSTOM_CONNECTION"), false);
  }
  const custom = { OPENCODE_MODELS_URL: source };
  assert.equal(await changesWith(custom, "CUSTOM_CONNECTION"), true);
  assert.equal(await changesWith(custom, "USUAL_CONNECTION"), false);
  // Kilo's variable means nothing to OpenCode.
  assert.equal(
    await changesWith({ KILO_MODELS_URL: source }, "CUSTOM_CONNECTION"),
    false,
  );
});
