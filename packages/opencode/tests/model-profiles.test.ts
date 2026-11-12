import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  type Host,
  agentOnlyKeys,
  assignmentsAreStale,
  availabilityFilePath,
  availableModels,
  fallbackModel,
  fallbackToastLines,
  knownAvailableModels,
  knownRefModels,
  readConnectedProviders,
  readReport,
  readSavedSelection,
  rememberAvailableModels,
  saveSelection,
  selectedChoice,
  selectedNotice,
  selectionFilePath,
} from "@lunchbox-labs/model-profiles-core";
import * as core from "@lunchbox-labs/model-profiles-core";
import { host } from "../src/host.ts";
import server from "../src/server.ts";
import tui from "../src/tui.ts";

/** The core takes the host first; the tests call its functions as the OpenCode package does. */
const forHost =
  <Rest extends unknown[], Result>(
    run: (host: Host, ...rest: Rest) => Result,
  ) =>
  (...rest: Rest): Result =>
    run(host, ...rest);
const modelsFilePath = forHost(core.modelsFilePath);
const resolveModelProfiles = forHost(core.resolveModelProfiles);
const providerSetupKey = forHost(core.providerSetupKey);
const modelConfigOptions = forHost(core.modelConfigOptions);
const unavailableModelNotices = forHost(core.unavailableModelNotices);
const parseModelsDocument = forHost(core.parseModelsDocument);
const publishReport = forHost(core.publishReport);
const applyModelRefs = forHost(core.applyModelRefs);
const selectProfile = forHost(core.selectProfile);
const cacheDirectory = forHost(core.cacheDirectory);
const dataDirectory = forHost(core.dataDirectory);
const processProfile = forHost(core.processProfile);
const stateDirectory = forHost(core.stateDirectory);
const { builtInAgents: builtInAgentNames, packageName } = host;

const realisticModels = `{
  // Comments and trailing commas are allowed.
  "defaultProfile": "primary",
  "defaults": {
    "reasoning": "openai/gpt-6-astra",
    "system": { "model": "openai/gpt-5.6-terra", "variant": "medium" },
  },
  "profiles": {
    "primary": {
      "coding": { "model": "openai/gpt-5.6-sol", "variant": "medium" },
    },
    "anthropic-latest": {
      "reasoning": { "model": "anthropic/claude-opus-5-5", "variant": "high" },
      "coding": "anthropic/claude-sonnet-5-5",
    },
  },
  "builtins": { "general": "coding", "title": "system" },
}`;

function documentOf(text: string) {
  return parseModelsDocument(text, "models.jsonc");
}

async function temporaryRoot(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "model-profiles-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    OPENCODE_CONFIG_DIR: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  await mkdir(environment.OPENCODE_CONFIG_DIR, { recursive: true });
  return { root, environment, configFile: modelsFilePath({}, environment) };
}

test("parses string and object model values and skips bad entries individually", () => {
  const { document, notices } = documentOf(`{
    "defaults": {
      "reasoning": "openai/gpt-6-astra",
      "coding": { "model": "openai/gpt-5.6-sol", "variant": "medium" },
      "no-provider": "gpt-6",
      "empty-variant": { "model": "openai/gpt-6", "variant": "" },
      "number": 3
    },
    "profiles": { "fast": { "coding": "openai/gpt-6-luna", "bad": {} }, "broken": [] },
    "builtins": { "title": "coding", "reviewer": "coding", "explore": 1 },
    "defaultProfile": "",
    "default": {}
  }`);
  assert.deepEqual(document.defaults, {
    reasoning: { model: "openai/gpt-6-astra" },
    coding: { model: "openai/gpt-5.6-sol", variant: "medium" },
    "empty-variant": { model: "openai/gpt-6" },
  });
  assert.deepEqual(document.profiles, {
    fast: { coding: { model: "openai/gpt-6-luna" } },
    broken: {},
  });
  assert.deepEqual(document.builtins, { title: "coding" });
  assert.equal(document.defaultProfile, undefined);
  for (const fragment of [
    "defaults.no-provider",
    "defaults.empty-variant",
    "defaults.number",
    "profiles.fast.bad",
    "profiles.broken",
    "builtins.reviewer is not a built-in agent",
    "builtins.explore",
    "defaultProfile",
    'Unknown top-level key "default"',
  ]) {
    assert.ok(
      notices.some((notice) => notice.includes(fragment)),
      `a notice mentions ${fragment}: ${notices.join(" | ")}`,
    );
  }
});

test("refs take OpenCode's agent model settings and move other keys into options, as OpenCode does", () => {
  const { document, notices } = documentOf(`{
    "defaults": {
      "tuned": {
        "reasoningEffort": "low",
        "model": "openai/gpt-6",
        "variant": "high",
        "temperature": 0.2,
        "top_p": 0.9,
        "options": { "reasoningEffort": "medium", "store": false },
        "textVerbosity": "low",
      },
      "thinking": {
        "model": "anthropic/claude-opus-5-5",
        "options": { "thinking": { "type": "enabled", "budgetTokens": 16000 } },
      },
      "bad-settings": {
        "model": "openai/gpt-6",
        "temperature": "warm",
        "top_p": null,
        "options": [],
        "prompt": "Be brief.",
        "steps": 3,
        "modelRef": "tuned",
      },
    },
  }`);
  assert.deepEqual(document.defaults, {
    tuned: {
      model: "openai/gpt-6",
      variant: "high",
      temperature: 0.2,
      top_p: 0.9,
      options: {
        reasoningEffort: "low",
        store: false,
        textVerbosity: "low",
      },
    },
    thinking: {
      model: "anthropic/claude-opus-5-5",
      options: { thinking: { type: "enabled", budgetTokens: 16000 } },
    },
    "bad-settings": { model: "openai/gpt-6" },
  });
  assert.deepEqual(notices, [
    "defaults.bad-settings.temperature is not a number; it is left out.",
    "defaults.bad-settings.top_p is not a number; it is left out.",
    "defaults.bad-settings.options is not an object of provider options; it is left out.",
    "defaults.bad-settings.prompt configures the agent, not its model; it is left out.",
    "defaults.bad-settings.steps configures the agent, not its model; it is left out.",
    "defaults.bad-settings.modelRef configures the agent, not its model; it is left out.",
  ]);
});

test("a ref's settings replace the agent's and its options merge over the agent's own, only when the ref applies", () => {
  const { document } = documentOf(`{
    "defaults": {
      "tuned": {
        "model": "openai/gpt-6",
        "temperature": 0.2,
        "options": { "reasoningEffort": "high", "nested": { "a": 1 }, "list": [2] },
      },
      "plain": "openai/gpt-6-luna",
    },
  }`);
  const agents = {
    builder: {
      modelRef: "tuned",
      model: "openai/own",
      temperature: 0.7,
      top_p: 0.5,
      options: {
        reasoningEffort: "low",
        nested: { b: 2 },
        list: [1],
        custom: true,
      },
    },
    helper: { modelRef: "plain", temperature: 0.7, options: { custom: true } },
  };
  const snapshot = structuredClone(agents);
  const applied = applyModelRefs(agents, document, null);
  assert.deepEqual(applied.agents, {
    builder: {
      model: "openai/gpt-6",
      temperature: 0.2,
      top_p: 0.5,
      options: {
        reasoningEffort: "high",
        nested: { b: 2, a: 1 },
        list: [2],
        custom: true,
      },
    },
    helper: {
      model: "openai/gpt-6-luna",
      temperature: 0.7,
      options: { custom: true },
    },
  });
  assert.deepEqual(agents, snapshot, "the configured agents are not changed");
  assert.deepEqual(
    applied.refs.map((ref) => [ref.ref, ref.settings]),
    [
      ["plain", undefined],
      ["tuned", ["temperature", "reasoningEffort", "nested", "list"]],
    ],
  );
  const unavailable = applyModelRefs(
    agents,
    document,
    null,
    new Set(["openai/gpt-6-luna", "openai/own"]),
  );
  assert.deepEqual(
    unavailable.agents.builder,
    {
      model: "openai/own",
      temperature: 0.7,
      top_p: 0.5,
      options: {
        reasoningEffort: "low",
        nested: { b: 2 },
        list: [1],
        custom: true,
      },
    },
    "an unapplied ref leaves the agent's own model and settings",
  );
});

test("a profile's ref replaces the default's whole entry, settings included", () => {
  const { document, notices } = documentOf(`{
    "defaults": {
      "coding": { "model": "openai/gpt-6", "temperature": 0.2, "store": false },
    },
    "profiles": {
      "fast": {
        "coding": "openai/gpt-6-luna",
        "broken": { "model": "openai/gpt-6", "top_p": "high" },
      },
    },
  }`);
  assert.deepEqual(notices, [
    "profiles.fast.broken.top_p is not a number; it is left out.",
  ]);
  const agents = { builder: { modelRef: "coding" } };
  assert.deepEqual(applyModelRefs(agents, document, "fast").agents.builder, {
    model: "openai/gpt-6-luna",
  });
  assert.deepEqual(applyModelRefs(agents, document, null).agents.builder, {
    model: "openai/gpt-6",
    temperature: 0.2,
    options: { store: false },
  });
});

test("the config hook strips the modelRef OpenCode copied into options and merges the ref's options there", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(
    configFile,
    `{ "defaults": { "coding": { "model": "openai/gpt-6", "top_p": 0.9, "reasoningEffort": "high" } } }`,
  );
  // OpenCode moves keys it does not know on an agent entry, modelRef included, into the agent's options.
  const config: Record<string, unknown> = {
    agent: {
      build: {
        modelRef: "coding",
        options: { modelRef: "coding", custom: 1, reasoningEffort: "low" },
      },
    },
  };
  await resolveModelProfiles(config, {
    configFile,
    worktree: "/work/repo",
    environment,
  });
  assert.deepEqual(config.agent, {
    build: {
      model: "openai/gpt-6",
      top_p: 0.9,
      options: { custom: 1, reasoningEffort: "high" },
    },
  });
});

test("a request on another model than the ref's gets the agent's own temperature and top_p back", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(
    configFile,
    `{
      "defaults": {
        "tuned": { "model": "openai/gpt-6", "temperature": 0.2, "top_p": 0.9 },
        "plain": "openai/gpt-6-luna",
      },
    }`,
  );
  Object.assign(process.env, environment);
  t.after(() => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
  });
  const hooks = await server.server(
    { worktree: "/work/repo", directory: "/work/repo" } as never,
    undefined,
  );
  await hooks.config?.({
    agent: {
      builder: { modelRef: "tuned", temperature: 0.7 },
      helper: { modelRef: "plain", temperature: 0.7, top_p: 0.5 },
    },
  });
  const params = async (agent: string, model: string, temperature?: number) => {
    const output = { temperature, topP: 0.9, topK: 0, options: {} };
    const separator = model.indexOf("/");
    await hooks["chat.params"]?.(
      {
        agent,
        model: {
          providerID: model.slice(0, separator),
          id: model.slice(separator + 1),
        },
      } as never,
      output as never,
    );
    return { temperature: output.temperature, topP: output.topP };
  };
  assert.deepEqual(
    await params("builder", "openai/gpt-6", 0.2),
    { temperature: 0.2, topP: 0.9 },
    "the ref's own model keeps the ref's settings",
  );
  assert.deepEqual(
    await params("builder", "anthropic/claude-opus-5-5", 0.2),
    { temperature: 0.7, topP: undefined },
    "another model gets the agent's own temperature and the provider's default top_p",
  );
  assert.deepEqual(
    await params("builder", "anthropic/claude-opus-5-5", undefined),
    { temperature: undefined, topP: undefined },
    "a model OpenCode sends no temperature to still gets none",
  );
  assert.deepEqual(
    await params("helper", "anthropic/claude-opus-5-5", 0.7),
    { temperature: 0.7, topP: 0.9 },
    "settings the ref leaves out are not touched",
  );
  assert.deepEqual(await params("other", "openai/gpt-6", 0.3), {
    temperature: 0.3,
    topP: 0.9,
  });
  await assert.doesNotReject(async () =>
    hooks["chat.params"]?.({} as never, {} as never),
  );
});

test("schema.json rejects the same agent-only keys in a ref as the plugin", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schema.json", import.meta.url), "utf8"),
  ) as {
    $defs: {
      refs: {
        additionalProperties: {
          oneOf: [unknown, { properties: Record<string, unknown> }];
        };
      };
    };
  };
  const properties = schema.$defs.refs.additionalProperties.oneOf[1].properties;
  assert.deepEqual(
    Object.keys(properties)
      .filter((key) => properties[key] === false)
      .sort(),
    [...agentOnlyKeys].sort(),
  );
});

test("a syntax error or non-object file yields no refs and a notice instead of throwing", () => {
  const broken = documentOf('{ "defaults": { "a": "x/y" ');
  assert.deepEqual(broken.document.defaults, {});
  assert.match(broken.notices[0] ?? "", /syntax error .* line 1/);
  const list = documentOf("[]");
  assert.match(list.notices[0] ?? "", /not a JSON object/);
});

test("the selected profile's ref wins over defaults, and unresolved refs leave the agent as configured", () => {
  const { document } = documentOf(realisticModels);
  const agents = {
    builder: { modelRef: "reasoning", mode: "primary" },
    reviewer: { modelRef: "coding", model: "openai/old", variant: "high" },
    helper: { modelRef: "missing", model: "openai/kept" },
  };
  const primary = applyModelRefs(agents, document, "primary");
  assert.deepEqual(primary.agents.builder, {
    mode: "primary",
    model: "openai/gpt-6-astra",
  });
  assert.deepEqual(primary.agents.reviewer, {
    model: "openai/gpt-5.6-sol",
    variant: "medium",
  });
  assert.deepEqual(primary.agents.helper, { model: "openai/kept" });

  const anthropic = applyModelRefs(agents, document, "anthropic-latest");
  assert.deepEqual(anthropic.agents.builder, {
    mode: "primary",
    model: "anthropic/claude-opus-5-5",
    variant: "high",
  });
  assert.deepEqual(
    anthropic.agents.reviewer,
    { model: "anthropic/claude-sonnet-5-5", variant: "high" },
    "a ref without a variant keeps the agent's own variant",
  );

  const defaultsOnly = applyModelRefs(agents, document, null);
  assert.deepEqual(defaultsOnly.agents.reviewer, {
    model: "openai/old",
    variant: "high",
  });
  assert.ok(
    defaultsOnly.notices.some(
      (notice) =>
        notice.includes('Ref "coding" is not defined in defaults') &&
        notice.includes("reviewer"),
    ),
  );
  const coding = defaultsOnly.refs.find((ref) => ref.ref === "coding");
  assert.equal(coding?.source, "unresolved");
  assert.deepEqual(
    coding.agents,
    ["reviewer", "general"],
    "built-ins mapped through builtins count as users of the ref",
  );
});

test("built-in agents take refs from builtins unless they set their own ref or model, and others keep OpenCode's default", () => {
  const { document } = documentOf(realisticModels);
  const applied = applyModelRefs(
    {
      general: { color: "#8AF793" },
      title: { modelRef: "reasoning" },
      explore: { color: "#8AEEF7" },
      plan: { disable: true },
    },
    document,
    "primary",
  );
  assert.deepEqual(applied.agents, {
    general: {
      color: "#8AF793",
      model: "openai/gpt-5.6-sol",
      variant: "medium",
    },
    title: { model: "openai/gpt-6-astra" },
    explore: { color: "#8AEEF7" },
    plan: { disable: true },
  });

  const pinned = applyModelRefs(
    { general: { model: "openai/pinned" } },
    document,
    "primary",
  );
  assert.deepEqual(
    pinned.agents.general,
    { model: "openai/pinned" },
    "a built-in agent entry that sets its own model keeps it over builtins",
  );

  const unconfigured = applyModelRefs(undefined, document, "primary");
  assert.deepEqual(
    unconfigured.agents,
    {
      general: { model: "openai/gpt-5.6-sol", variant: "medium" },
      title: { model: "openai/gpt-5.6-terra", variant: "medium" },
    },
    "a built-in with a ref but no agent entry gets one; other built-ins get none",
  );
});

test("modelRef is removed from agents and their options without mutating the configured objects", () => {
  const document = { ...documentOf(realisticModels).document, builtins: {} };
  const fromMarkdown = {
    modelRef: "reasoning",
    options: { modelRef: "reasoning", reasoningEffort: "low" },
  };
  const fromOptions = { options: { modelRef: "system" } };
  const invalid = { modelRef: 7, options: { modelRef: 7 } };
  const configured = { fromMarkdown, fromOptions, invalid };
  const snapshot = structuredClone(configured);
  const first = applyModelRefs(configured, document, null);
  assert.deepEqual(first.agents, {
    fromMarkdown: {
      options: { reasoningEffort: "low" },
      model: "openai/gpt-6-astra",
    },
    fromOptions: {
      options: {},
      model: "openai/gpt-5.6-terra",
      variant: "medium",
    },
    invalid: { options: {} },
  });
  assert.ok(first.notices.some((notice) => notice.includes("Agent invalid")));
  assert.deepEqual(configured, snapshot);
  assert.deepEqual(applyModelRefs(configured, document, null), first);
});

test("profile selection prefers the environment, then the saved choice, then defaultProfile", () => {
  const { document } = documentOf(realisticModels);
  assert.deepEqual(selectProfile(document, "anthropic-latest", null), {
    profile: "anthropic-latest",
    source: "environment",
    notices: [],
  });
  assert.deepEqual(selectProfile(document, undefined, null), {
    profile: null,
    source: "saved",
    notices: [],
  });
  assert.deepEqual(selectProfile(document, undefined, undefined), {
    profile: "primary",
    source: "defaultProfile",
    notices: [],
  });
  assert.equal(
    selectProfile(
      { ...document, defaultProfile: undefined },
      undefined,
      undefined,
    ).source,
    "none",
  );
  const unknown = selectProfile(document, "gone", "removed");
  assert.equal(unknown.profile, "primary");
  assert.equal(unknown.source, "defaultProfile");
  assert.deepEqual(unknown.notices, [
    'Profile "gone" from OPENCODE_MODEL_PROFILE is not defined in models.jsonc; using profile "primary".',
    'Profile "removed" from the saved worktree selection is not defined in models.jsonc; using profile "primary".',
  ]);
  assert.deepEqual(selectProfile(document, "gone", null), {
    profile: null,
    source: "saved",
    notices: [
      'Profile "gone" from OPENCODE_MODEL_PROFILE is not defined in models.jsonc; using defaults only.',
    ],
  });
  assert.equal(processProfile({ OPENCODE_MODEL_PROFILE: "  " }), undefined);
  assert.equal(processProfile({ OPENCODE_MODEL_PROFILE: "fast" }), "fast");
});

test("selection files are keyed per worktree on POSIX and Windows paths and round-trip", async (t) => {
  const posix = selectionFilePath("/state/opencode", "/work/repo", "linux");
  assert.match(
    posix,
    /^\/state\/opencode\/model-profiles\/worktrees\/[0-9a-f]{32}\.json$/,
  );
  assert.equal(
    selectionFilePath("/state/opencode", "/work/repo/", "linux"),
    posix,
  );
  assert.notEqual(
    selectionFilePath("/state/opencode", "/work/Repo", "linux"),
    posix,
  );

  const windows = selectionFilePath(
    "C:\\Users\\me\\.local\\state\\opencode",
    "C:\\Work\\Repo",
    "win32",
  );
  assert.match(
    windows,
    /^C:\\Users\\me\\\.local\\state\\opencode\\model-profiles\\worktrees\\[0-9a-f]{32}\.json$/,
  );
  for (const variant of ["c:\\work\\repo\\", "C:/Work/Repo", "c:/WORK/repo/"]) {
    assert.equal(
      selectionFilePath(
        "C:\\Users\\me\\.local\\state\\opencode",
        variant,
        "win32",
      ),
      windows,
      variant,
    );
  }
  assert.equal(
    stateDirectory({ XDG_STATE_HOME: "/xdg" }),
    join("/xdg", "opencode"),
  );

  const { root } = await temporaryRoot(t);
  const file = selectionFilePath(join(root, "state"), "/work/repo");
  assert.deepEqual(await readSavedSelection(file), { profile: undefined });
  await saveSelection(file, "/work/repo", "fast");
  assert.deepEqual(await readSavedSelection(file), { profile: "fast" });
  await saveSelection(file, "/work/repo", null);
  assert.deepEqual(await readSavedSelection(file), { profile: null });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    version: 1,
    worktree: "/work/repo",
    profile: null,
  });
  await writeFile(file, "{ not json");
  const corrupt = await readSavedSelection(file);
  assert.equal(corrupt.profile, undefined);
  assert.match(corrupt.notice ?? "", /invalid/);
});

test("every fallback reports a notice and leaves agents on OpenCode's models", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  const agents = () => ({
    builder: { modelRef: "reasoning", model: "openai/native" },
  });
  const resolveWith = async (extraEnvironment: Record<string, string> = {}) => {
    const config: Record<string, unknown> = { agent: agents() };
    const { report } = await resolveModelProfiles(config, {
      configFile,
      worktree: "/work/repo",
      environment: { ...environment, ...extraEnvironment },
    });
    return { config, report };
  };

  const missing = await resolveWith();
  assert.deepEqual(missing.config.agent, {
    builder: { model: "openai/native" },
  });
  assert.equal(missing.report.notices.length, 1);
  assert.match(missing.report.notices[0] ?? "", /^No models file/);

  await writeFile(configFile, "{ oops");
  const broken = await resolveWith();
  assert.deepEqual(broken.config.agent, {
    builder: { model: "openai/native" },
  });
  assert.equal(
    broken.report.notices.length,
    1,
    "an unusable file reports one problem, not one per ref",
  );
  assert.match(broken.report.notices[0] ?? "", /syntax error/);

  await writeFile(configFile, '{ "defaults": { "reasoning": "not-a-model" } }');
  const badEntry = await resolveWith();
  assert.deepEqual(badEntry.config.agent, {
    builder: { model: "openai/native" },
  });
  assert.ok(
    badEntry.report.notices.some((notice) =>
      notice.includes("defaults.reasoning"),
    ),
  );
  assert.ok(
    badEntry.report.notices.some((notice) =>
      notice.includes('Ref "reasoning"'),
    ),
  );

  await writeFile(
    configFile,
    '{ "defaults": { "reasoning": "openai/gpt-6-astra" }, "profiles": { "fast": { "reasoning": "openai/gpt-6-luna" } } }',
  );
  const unknownProfile = await resolveWith({ OPENCODE_MODEL_PROFILE: "gone" });
  assert.deepEqual(unknownProfile.config.agent, {
    builder: { model: "openai/gpt-6-astra" },
  });
  assert.equal(unknownProfile.report.profile, null);
  assert.ok(
    unknownProfile.report.notices.some((notice) => notice.includes('"gone"')),
  );

  const { selectionFile } = unknownProfile.report;
  await mkdir(dirname(selectionFile), { recursive: true });
  await writeFile(selectionFile, "garbage");
  const corruptSelection = await resolveWith();
  assert.equal(corruptSelection.report.profileSource, "none");
  assert.ok(
    corruptSelection.report.notices.some((notice) =>
      notice.includes("saved profile"),
    ),
  );
});

test("models.jsonc lives in OpenCode's config directory unless configFile points elsewhere", () => {
  const configDirectory = resolve("/config/opencode");
  const environment = { OPENCODE_CONFIG_DIR: configDirectory };
  assert.equal(
    modelsFilePath(undefined, environment),
    join(configDirectory, "models.jsonc"),
  );
  assert.equal(
    modelsFilePath({ configFile: "models/work.jsonc" }, environment),
    join(configDirectory, "models", "work.jsonc"),
  );
  const elsewhere = resolve("/elsewhere/models.jsonc");
  assert.equal(
    modelsFilePath({ configFile: elsewhere }, environment),
    elsewhere,
  );
});

test("the environment profile overrides the saved worktree selection", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(configFile, realisticModels);
  const worktree = "/work/repo";
  await saveSelection(
    selectionFilePath(stateDirectory(environment), worktree),
    worktree,
    null,
  );
  const config: Record<string, unknown> = {
    agent: { builder: { modelRef: "reasoning" } },
  };
  const { report } = await resolveModelProfiles(config, {
    configFile,
    worktree,
    environment: { ...environment, OPENCODE_MODEL_PROFILE: "anthropic-latest" },
  });
  assert.equal(report.profile, "anthropic-latest");
  assert.equal(report.profileSource, "environment");
  assert.equal(report.environmentProfile, "anthropic-latest");
  assert.deepEqual((config.agent as Record<string, unknown>).builder, {
    model: "anthropic/claude-opus-5-5",
    variant: "high",
  });

  const { report: saved } = await resolveModelProfiles(
    { agent: { builder: { modelRef: "reasoning" } } },
    { configFile, worktree, environment },
  );
  assert.equal(saved.profile, null);
  assert.equal(saved.profileSource, "saved");
});

test("the server config hook applies refs, publishes its report in its plugin entry and never throws", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(configFile, realisticModels);
  Object.assign(process.env, environment);
  t.after(() => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
  });
  const hooks = await server.server(
    { worktree: "/work/repo", directory: "/work/repo/app" } as never,
    undefined,
  );
  const globalAgent = { modelRef: "reasoning" };
  const config = {
    plugin: ["other-plugin", `${packageName}@1.0.0`],
    agent: { builder: globalAgent },
  };
  await hooks.config?.(config);
  assert.deepEqual(config.agent.builder, { model: "openai/gpt-6-astra" });
  assert.deepEqual(globalAgent, { modelRef: "reasoning" });
  assert.equal(config.plugin[0], "other-plugin");
  const report = readReport(config);
  assert.equal(report?.profile, "primary");
  assert.equal(report.profileSource, "defaultProfile");
  assert.deepEqual(report.profiles, ["primary", "anthropic-latest"]);
  assert.equal(report.configFile, configFile);

  const odd = { agent: "not an object", plugin: "nope" };
  await assert.doesNotReject(async () => hooks.config?.(odd as never));
});

test("the report is published only into this plugin's entry", () => {
  const report = {
    version: 1 as const,
    configFile: "/c/models.jsonc",
    selectionFile: "/s/x.json",
    worktree: "/w",
    profiles: [],
    profile: null,
    profileSource: "none" as const,
    refs: [],
    notices: [],
  };
  const options = { configFile: "models.jsonc" };
  const tupleConfig: Record<string, unknown> = {
    plugin: ["a", ["./local-plugin.ts", options]],
  };
  assert.equal(publishReport(tupleConfig, options, report), true);
  assert.deepEqual((tupleConfig.plugin as unknown[])[1], [
    "./local-plugin.ts",
    { configFile: "models.jsonc", modelProfilesReport: report },
  ]);
  assert.deepEqual(readReport(tupleConfig), report);

  const foreign: Record<string, unknown> = { plugin: ["a", "b@1"] };
  assert.equal(publishReport(foreign, {}, report), false);
  assert.equal(readReport(foreign), undefined);
});

const dialogReport = {
  version: 1 as const,
  configFile: "/c/models.jsonc",
  selectionFile: "/s/x.json",
  worktree: "/w",
  profiles: ["primary"],
  profile: "primary",
  profileSource: "environment" as const,
  environmentProfile: "primary",
  refs: [
    {
      ref: "coding",
      model: "openai/gpt-5.6-sol",
      variant: "medium",
      settings: ["temperature", "reasoningEffort"],
      source: "profile" as const,
      agents: ["general"],
    },
    { ref: "missing", source: "unresolved" as const, agents: ["helper"] },
  ],
  notices: ["Something fell back."],
};

test("the /model-config dialog lists profiles with the current one marked, refs with their agents, and fallbacks", () => {
  const options = modelConfigOptions({
    report: dialogReport,
    profiles: ["primary", "fast"],
    savedProfile: undefined,
    defaultProfile: undefined,
    notices: dialogReport.notices,
  });
  assert.deepEqual(
    options.map((option) => [option.title, option.value, option.footer]),
    [
      ["Defaults only", "defaults", undefined],
      ["primary", "profile:primary", "current, OPENCODE_MODEL_PROFILE"],
      ["fast", "profile:fast", undefined],
      [
        "coding → openai/gpt-5.6-sol (medium; sets temperature, reasoningEffort)",
        "ref:coding",
        "profile",
      ],
      ["missing → not defined, OpenCode's model", "ref:missing", "fallback"],
      ["Something fell back.", "notice:0", undefined],
    ],
  );
  assert.match(
    options[0]?.category ?? "",
    /OPENCODE_MODEL_PROFILE=primary overrides/,
  );
  assert.equal(options[3]?.description, "general");
  assert.deepEqual(
    options.map((option) => selectedChoice(option.value)),
    [
      { kind: "save", profile: null },
      { kind: "save", profile: "primary" },
      { kind: "save", profile: "fast" },
      undefined,
      undefined,
      undefined,
    ],
  );
  assert.equal(
    selectedNotice("notice:0", dialogReport.notices),
    "Something fell back.",
  );
  assert.equal(selectedNotice("ref:coding", dialogReport.notices), undefined);
});

test("the /model-config dialog shows a saved pick that has not applied yet and offers to follow defaultProfile again", () => {
  const options = modelConfigOptions({
    report: {
      ...dialogReport,
      environmentProfile: undefined,
      profile: "primary",
      profileSource: "saved",
    },
    profiles: ["primary", "fast"],
    savedProfile: "fast",
    defaultProfile: "primary",
    notices: [],
  });
  assert.deepEqual(
    options
      .filter((option) => option.category?.startsWith("Profile") === true)
      .map((option) => [option.title, option.footer]),
    [
      ["Follow defaultProfile (primary)", undefined],
      ["Defaults only", undefined],
      ["primary", "current, saved"],
      ["fast", "saved, applies on reload"],
    ],
  );
  assert.deepEqual(selectedChoice(options[0]?.value ?? ""), {
    kind: "followDefaultProfile",
  });

  const nothingSaved = modelConfigOptions({
    report: { ...dialogReport, profileSource: "defaultProfile" },
    profiles: ["primary"],
    savedProfile: undefined,
    defaultProfile: "primary",
    notices: [],
  });
  assert.ok(
    !nothingSaved.some((option) => option.title.startsWith("Follow")),
    "following defaultProfile is offered only when a choice is saved",
  );
});

test("models no connected provider offers are reported, and toasts summarise several problems", () => {
  const refs = [
    ...dialogReport.refs,
    {
      ref: "reasoning",
      model: "anthropic/claude-opus-5-5",
      source: "defaults" as const,
      agents: ["plan", "reviewer"],
    },
    {
      ref: "nested",
      model: "openrouter/openai/gpt-6-astra",
      source: "defaults" as const,
      agents: ["helper"],
    },
    {
      ref: "unused",
      model: "anthropic/claude-haiku-5-5",
      source: "defaults" as const,
      agents: [],
    },
  ];
  const providers = [
    { id: "openai", models: { "gpt-6-astra": {} } },
    { id: "openrouter", models: { "openai/gpt-6-astra": {} } },
  ];
  assert.deepEqual(unavailableModelNotices(refs, providers), [
    'Ref "coding" uses openai/gpt-5.6-sol, but "openai" has no model "gpt-5.6-sol"; general falls back to OpenCode\'s model until you fix the ref or pick another profile.',
    'Ref "reasoning" uses anthropic/claude-opus-5-5, but provider "anthropic" is not connected; plan, reviewer fall back to OpenCode\'s model until you fix the ref or pick another profile.',
  ]);
  assert.deepEqual(
    unavailableModelNotices(refs, []),
    [],
    "nothing is reported before the provider list loads",
  );

  assert.deepEqual(fallbackToastLines([]), []);
  assert.deepEqual(fallbackToastLines(["one"]), ["one"]);
  assert.deepEqual(fallbackToastLines(["one", "two", "three"]), [
    "one",
    "2 more problems; see /model-config.",
  ]);
});

test("schema.json allows exactly the built-in agent names under builtins", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schema.json", import.meta.url), "utf8"),
  ) as { properties: { builtins: { properties: Record<string, unknown> } } };
  assert.deepEqual(
    Object.keys(schema.properties.builtins.properties).sort(),
    [...builtInAgentNames].sort(),
  );
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string };
  assert.equal(packageName, manifest.name);
});

test("refs to models known to be unavailable are not applied, and agents keep their own model", () => {
  const { document } = documentOf(realisticModels);
  const agents = {
    builder: { modelRef: "reasoning", model: "openai/own", variant: "low" },
    helper: { modelRef: "coding" },
  };
  const available = new Set(["openai/gpt-5.6-sol", "openai/own"]);
  const applied = applyModelRefs(agents, document, "primary", available);
  assert.deepEqual(applied.agents, {
    builder: { model: "openai/own", variant: "low" },
    helper: { model: "openai/gpt-5.6-sol", variant: "medium" },
    general: { model: "openai/gpt-5.6-sol", variant: "medium" },
  });
  assert.deepEqual(
    applied.assignments.find((assignment) => assignment.agent === "builder"),
    {
      agent: "builder",
      ref: "reasoning",
      model: "openai/gpt-6-astra",
      ownModel: "openai/own",
      ownVariant: "low",
      applied: false,
    },
  );
  assert.equal(
    applied.assignments.find((assignment) => assignment.agent === "title")
      ?.applied,
    false,
    "an unavailable built-in ref is not applied either",
  );
  assert.equal(
    "title" in applied.agents,
    false,
    "a built-in without an entry gets none when its ref is unavailable",
  );
  const reasoning = applied.refs.find((ref) => ref.ref === "reasoning");
  assert.equal(reasoning?.unavailable, true);
  assert.ok(
    applied.notices.includes(
      'Ref "reasoning" uses openai/gpt-6-astra, but "openai" has no model "gpt-6-astra"; builder falls back to OpenCode\'s model until you fix the ref or pick another profile.',
    ),
  );
  assert.deepEqual(
    unavailableModelNotices(
      applyModelRefs(agents, document, "primary").refs.filter(
        (ref) => ref.ref === "reasoning",
      ),
      [{ id: "openai", models: { "gpt-5.6-sol": {} } }],
    ),
    applied.notices.filter((notice) => notice.startsWith('Ref "reasoning"')),
    "the TUI's own check words the notice as the server does, so the reload does not toast it twice",
  );
  assert.equal(
    applyModelRefs(agents, document, "primary").assignments.every(
      (assignment) => assignment.applied,
    ),
    true,
    "without a known provider list every resolved ref applies",
  );
});

test("a fallback uses the agent's own model, then its parent's, then OpenCode's configured, recent or provider default model", () => {
  const assignment = {
    agent: "builder",
    ref: "reasoning",
    model: "gone/model",
    applied: true,
  };
  const connected = {
    providers: [
      { id: "anthropic", models: { "claude-haiku-5-5": {} } },
      {
        id: "openai",
        models: {
          "gpt-6-astra": {},
          own: {},
          recent: {},
          listed: { variants: { high: {} } },
        },
      },
    ],
    default: { anthropic: "claude-haiku-5-5", openai: "gpt-6-astra" },
  };
  const available = availableModels(connected);
  const base = {
    available,
    connected,
    configuredProviders: [],
    recent: [],
  };
  assert.deepEqual(
    fallbackModel({
      ...base,
      own: { model: "openai/own", variant: "low" },
      configuredModel: "openai/gpt-6-astra",
    }),
    { providerID: "openai", modelID: "own", variant: "low" },
  );
  assert.deepEqual(
    fallbackModel({
      ...base,
      own: { model: "openai/listed", variant: "low" },
    }),
    { providerID: "openai", modelID: "listed" },
    "a variant the model does not list is dropped",
  );
  assert.deepEqual(
    fallbackModel({
      ...base,
      own: { model: "gone/own" },
      configuredModel: "openai/gpt-6-astra",
    }),
    { providerID: "openai", modelID: "gpt-6-astra" },
  );
  assert.deepEqual(
    fallbackModel({
      ...base,
      parentModel: "openai/recent",
      configuredModel: "openai/gpt-6-astra",
    }),
    { providerID: "openai", modelID: "recent" },
    "a subagent without its own model follows its parent, as OpenCode does",
  );
  assert.deepEqual(
    fallbackModel({
      ...base,
      configuredModel: "gone/configured",
      recent: ["gone/recent", "openai/recent"],
    }),
    { providerID: "openai", modelID: "recent" },
  );
  assert.deepEqual(
    fallbackModel({ ...base, configuredProviders: ["openai"] }),
    { providerID: "openai", modelID: "gpt-6-astra" },
    "OpenCode prefers a provider configured under provider",
  );
  assert.deepEqual(fallbackModel(base), {
    providerID: "anthropic",
    modelID: "claude-haiku-5-5",
  });
  assert.equal(
    fallbackModel({
      ...base,
      connected: { providers: [], default: {} },
      available: new Set(),
    }),
    undefined,
  );
  assert.equal(
    assignmentsAreStale([assignment], available),
    true,
    "an applied ref whose model is unavailable calls for a reload",
  );
  assert.equal(
    assignmentsAreStale(
      [{ ...assignment, model: "openai/own", applied: false }],
      available,
    ),
    true,
    "an unapplied ref whose model became available calls for a reload",
  );
  assert.equal(
    assignmentsAreStale(
      [
        { ...assignment, applied: false },
        { ...assignment, model: "openai/own" },
      ],
      available,
    ),
    false,
  );
  assert.equal(readConnectedProviders({ nope: true }), undefined);
});

test("a prompt to an unavailable ref model moves to OpenCode's model, and the project reloads once idle", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(
    configFile,
    '{ "defaults": { "reasoning": "gone/model", "coding": "openai/gpt-6-astra" }, "builtins": { "compaction": "reasoning" } }',
  );
  Object.assign(process.env, environment);
  t.after(() => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
  });
  const calls: string[] = [];
  let busy = true;
  let terminals: unknown[] = [{ id: "pty" }];
  let disposeFails = true;
  const client = {
    config: {
      providers: () =>
        Promise.resolve({
          data: {
            providers: [
              {
                id: "openai",
                models: { "gpt-6-astra": {}, base: {}, picked: {} },
              },
            ],
            default: { openai: "gpt-6-astra" },
          },
        }),
    },
    app: { log: () => Promise.resolve({}) },
    session: {
      status: () =>
        Promise.resolve({
          data: { ses: { type: busy ? "busy" : "idle" } },
        }),
      get: ({ path }: { path: { id: string } }) =>
        Promise.resolve({
          data:
            path.id === "child"
              ? { parentID: "parent" }
              : path.id === "orphan"
                ? { parentID: "stored" }
                : path.id === "stored"
                  ? { model: { providerID: "openai", id: "gpt-6-astra" } }
                  : {},
        }),
    },
    pty: { list: () => Promise.resolve({ data: terminals }) },
    instance: {
      dispose: () => {
        calls.push("dispose");
        if (disposeFails) {
          disposeFails = false;
          return Promise.resolve({ error: "busy" });
        }
        return Promise.resolve({ data: true });
      },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "model-profiles-project-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginInput = { worktree: directory, directory, client } as never;
  const hooks = await server.server(pluginInput, undefined);
  const config = {
    model: "openai/base",
    agent: {
      builder: { modelRef: "reasoning" },
      coder: { modelRef: "coding" },
    },
  };
  await hooks.config?.(config);
  assert.deepEqual(config.agent.builder, { model: "gone/model" });

  const message = {
    agent: "builder",
    model: { providerID: "gone", modelID: "model", variant: "high" },
  };
  await hooks["chat.message"]?.({ sessionID: "parent" }, {
    message,
    parts: [],
  } as never);
  assert.deepEqual(message.model, { providerID: "openai", modelID: "base" });
  const providerSetup = await providerSetupKey(config, process.env, {
    data: dataDirectory(environment),
    cache: cacheDirectory(environment),
  });
  const saved = JSON.parse(
    await readFile(
      availabilityFilePath(
        stateDirectory(environment),
        directory,
        providerSetup,
      ),
      "utf8",
    ),
  ) as { models: string[] };
  assert.deepEqual(
    saved.models,
    ["openai/base", "openai/gpt-6-astra", "openai/picked"],
    "availability is saved for the next process",
  );

  const picked = {
    agent: "builder",
    model: { providerID: "openai", modelID: "picked" },
  };
  await hooks["chat.message"]?.({ sessionID: "parent", model: picked.model }, {
    message: picked,
    parts: [],
  } as never);
  const subagent = {
    agent: "helper",
    model: { providerID: "gone", modelID: "model" },
  };
  await hooks["chat.message"]?.(
    {
      sessionID: "child",
      model: { providerID: "gone", modelID: "model" },
    },
    { message: subagent, parts: [] } as never,
  );
  assert.deepEqual(
    subagent.model,
    { providerID: "openai", modelID: "picked" },
    "a subagent handed a ref's unavailable model follows its parent's model",
  );
  const stored = {
    agent: "helper",
    model: { providerID: "gone", modelID: "model" },
  };
  await hooks["chat.message"]?.(
    {
      sessionID: "orphan",
      model: { providerID: "gone", modelID: "model" },
    },
    { message: stored, parts: [] } as never,
  );
  assert.deepEqual(
    stored.model,
    { providerID: "openai", modelID: "gpt-6-astra" },
    "without a remembered parent model, the parent session's stored model is used",
  );

  const handSet = {
    agent: "reviewer",
    model: { providerID: "other", modelID: "missing" },
  };
  await hooks["chat.message"]?.({ sessionID: "plain" }, {
    message: handSet,
    parts: [],
  } as never);
  assert.deepEqual(
    handSet.model,
    { providerID: "other", modelID: "missing" },
    "an unavailable model no ref ever named is left as OpenCode would use it",
  );

  const explicit = {
    agent: "builder",
    model: { providerID: "other", modelID: "missing" },
  };
  await hooks["chat.message"]?.(
    { model: { providerID: "other", modelID: "missing" } } as never,
    { message: explicit, parts: [] } as never,
  );
  assert.deepEqual(
    explicit.model,
    { providerID: "other", modelID: "missing" },
    "a model the caller picked that no ref names is left alone",
  );

  const untouched = {
    agent: "coder",
    model: { providerID: "openai", modelID: "gpt-6-astra" },
  };
  await hooks["chat.message"]?.(
    {} as never,
    { message: untouched, parts: [] } as never,
  );
  assert.deepEqual(untouched.model, {
    providerID: "openai",
    modelID: "gpt-6-astra",
  });

  const idle = () =>
    hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses" } },
    } as never);
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [], "no reload while a session is busy");
  busy = false;
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [], "no reload while a terminal is open");
  terminals = [];
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["dispose"]);
  await idle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    calls,
    ["dispose", "dispose"],
    "a reload that failed is tried again",
  );

  const reloaded = await server.server(pluginInput, undefined);
  const next = {
    model: "openai/base",
    plugin: [packageName],
    agent: { builder: { modelRef: "reasoning" } },
  };
  await reloaded.config?.(next);
  assert.deepEqual(
    next.agent,
    { builder: {} },
    "after the reload the unavailable ref is left unapplied, built-ins included",
  );
  const report = readReport(next);
  assert.equal(
    report?.notices.some((notice) =>
      notice.startsWith('Ref "reasoning" uses gone/model'),
    ),
    true,
  );
  const remembered = {
    agent: "plan",
    model: { providerID: "gone", modelID: "model" },
  };
  await reloaded["chat.message"]?.(
    {} as never,
    { message: remembered, parts: [] } as never,
  );
  assert.deepEqual(
    remembered.model,
    { providerID: "openai", modelID: "base" },
    "a session that still remembers the unavailable model moves off it after the reload, whatever its agent",
  );
  await reloaded.event?.({
    event: { type: "session.idle", properties: { sessionID: "ses" } },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    calls,
    ["dispose", "dispose"],
    "a consistent project does not reload",
  );

  const otherDirectory = join(directory, "other");
  const otherFile = availabilityFilePath(
    stateDirectory(environment),
    otherDirectory,
    providerSetup,
  );
  await mkdir(dirname(otherFile), { recursive: true });
  await writeFile(
    otherFile,
    JSON.stringify({ version: 1, models: ["openai/base"] }),
  );
  assert.deepEqual(
    [
      ...((await knownAvailableModels(
        stateDirectory(environment),
        otherDirectory,
        providerSetup,
      )) ?? []),
    ],
    ["openai/base"],
    "a new process starts from the saved availability, kept per directory",
  );
});

interface FakeServerState {
  providers: { id: string; models: Record<string, unknown> }[];
  toasts: string[];
  busy?: boolean;
  terminals?: unknown[];
  disposeFails?: boolean;
  /** Makes the toast and the log calls reject, as a host without a client to show them might. */
  noticesFail?: boolean;
  disposals?: number;
  /** How many times the provider list was asked for. */
  providerChecks?: number;
  /** Holds the provider list back until it settles, like a slow host. */
  providersGate?: Promise<unknown>;
  /** How many terminal lists were answered. */
  terminalChecks?: number;
  /** Runs once, inside the next terminal list, after it has read the terminals. */
  onTerminalList?: () => void;
}

function fakeServerClient(state: FakeServerState) {
  return {
    config: {
      providers: () => {
        state.providerChecks = (state.providerChecks ?? 0) + 1;
        return (state.providersGate ?? Promise.resolve()).then(() => ({
          data: { providers: state.providers, default: { openai: "base" } },
        }));
      },
    },
    app: {
      log: () =>
        state.noticesFail === true
          ? Promise.reject(new Error("log unavailable"))
          : Promise.resolve({}),
    },
    tui: {
      showToast: ({ body }: { body: { message: string } }) => {
        state.toasts.push(body.message);
        return state.noticesFail === true
          ? Promise.reject(new Error("toast unavailable"))
          : Promise.resolve({ data: true });
      },
    },
    session: {
      status: () =>
        Promise.resolve({
          data: { ses: { type: state.busy === true ? "busy" : "idle" } },
        }),
      get: () => Promise.resolve({ data: {} }),
    },
    pty: {
      list: () => {
        const terminals = [...(state.terminals ?? [])];
        const onTerminalList = state.onTerminalList;
        state.onTerminalList = undefined;
        onTerminalList?.();
        state.terminalChecks = (state.terminalChecks ?? 0) + 1;
        return Promise.resolve({ data: terminals });
      },
    },
    instance: {
      dispose: () => {
        state.disposals = (state.disposals ?? 0) + 1;
        return Promise.resolve(
          state.disposeFails === true ? { error: "refused" } : { data: true },
        );
      },
    },
  };
}

async function serverProject(
  t: { after: (fn: () => void | Promise<void>) => void },
  models: string,
) {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(configFile, models);
  Object.assign(process.env, environment);
  t.after(() => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
  });
  const directory = await mkdtemp(join(tmpdir(), "model-profiles-project-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { environment, configFile, directory };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Waits for what the plugin's background work brings about, rather than for a fixed time a slow host may not meet. */
async function eventually(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type ServerHooks = Awaited<ReturnType<typeof server.server>>;

/** Sends a prompt through `chat.message` and returns the model it ends up on. */
async function sendPrompt(
  hooks: ServerHooks,
  agent: string,
  model: { providerID: string; modelID: string },
) {
  const message = { agent, model: { ...model } };
  await hooks["chat.message"]?.({ sessionID: "ses" }, {
    message,
    parts: [],
  } as never);
  await settle();
  return message.model;
}

test("a prompt that falls back shows a warning toast once, including when the ref was left unapplied", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
  };
  const pluginInput = {
    worktree: directory,
    directory,
    client: fakeServerClient(state),
  } as never;
  const prompt = (
    hooks: ServerHooks,
    model: { providerID: string; modelID: string },
  ) => sendPrompt(hooks, "builder", model);

  const first = await server.server(pluginInput, undefined);
  await first.config?.({
    model: "openai/base",
    agent: { builder: { modelRef: "reasoning" } },
  });
  const gone = { providerID: "gone", modelID: "model" };
  assert.deepEqual(await prompt(first, gone), {
    providerID: "openai",
    modelID: "base",
  });
  await prompt(first, gone);
  assert.deepEqual(
    state.toasts,
    [
      'Ref "reasoning" uses gone/model, which no connected provider offers; builder uses openai/base instead.',
    ],
    "a moved prompt is toasted, once per process",
  );

  state.toasts.length = 0;
  const reloaded = await server.server(pluginInput, undefined);
  const config = {
    model: "openai/base",
    agent: { builder: { modelRef: "reasoning" } },
  };
  await reloaded.config?.(config);
  assert.deepEqual(config.agent.builder, {}, "the ref is left unapplied");
  const base = { providerID: "openai", modelID: "base" };
  assert.deepEqual(await prompt(reloaded, base), base);
  assert.deepEqual(
    state.toasts,
    [],
    "the same fallback is not toasted again in this process",
  );

  const { directory: otherDirectory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" } }',
  );
  const other = {
    worktree: otherDirectory,
    directory: otherDirectory,
    client: fakeServerClient(state),
  } as never;
  const learn = await server.server(other, undefined);
  await learn.config?.({ agent: { builder: { modelRef: "reasoning" } } });
  await prompt(learn, base);
  state.toasts.length = 0;
  const unapplied = await server.server(other, undefined);
  await unapplied.config?.({
    model: "openai/base",
    agent: { builder: { modelRef: "reasoning" } },
  });
  await prompt(unapplied, base);
  assert.deepEqual(state.toasts, [
    'Ref "reasoning" uses gone/model, which no connected provider offers; builder uses openai/base instead.',
  ]);
});

/** One OpenCode process on the directory: the config hook, a prompt to builder, then an idle session. */
const processDriver = `
const { default: server } = await import(process.env.MODEL_PROFILES_SERVER);
const directory = process.env.MODEL_PROFILES_DIRECTORY;
const providers = process.env.MODEL_PROFILES_PROVIDERS.split(",").map((id) => ({
  id,
  models: id === "anthropic" ? { opus: {} } : { base: {} },
}));
let reloaded = false;
const client = {
  config: { providers: async () => ({ data: { providers, default: { openai: "base" } } }) },
  app: { log: async () => ({}) },
  tui: { showToast: async () => ({ data: true }) },
  session: { status: async () => ({ data: {} }), get: async () => ({ data: {} }) },
  pty: { list: async () => ({ data: [] }) },
  instance: { dispose: async () => { reloaded = true; return { data: true }; } },
};
const hooks = await server.server({ worktree: directory, directory, client }, undefined);
const config = { model: "openai/base", agent: { builder: { modelRef: "reasoning" } } };
await hooks.config(config);
const compaction = config.agent.compaction?.model ?? null;
const message = {
  agent: "builder",
  model: config.agent.builder.model === undefined
    ? { providerID: "openai", modelID: "base" }
    : { providerID: "anthropic", modelID: "opus" },
};
await hooks["chat.message"]({ sessionID: "ses" }, { message, parts: [] });
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses" } } });
await new Promise((resolve) => setTimeout(resolve, 30));
console.log(JSON.stringify({ compaction, ranOn: message.model.providerID + "/" + message.model.modelID, reloaded }));
`;

test("processes with different providers on one directory each keep their own saved availability", async (t) => {
  const { environment, configFile } = await temporaryRoot(t);
  await writeFile(
    configFile,
    '{ "defaults": { "reasoning": "anthropic/opus" }, "builtins": { "compaction": "reasoning" } }',
  );
  const directory = await mkdtemp(join(tmpdir(), "model-profiles-project-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const startProcess = async (withAnthropic: boolean) => {
    const { MODEL_PROFILES_TEST_API_KEY: _inherited, ...inherited } =
      process.env;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "--eval",
        processDriver,
      ],
      {
        env: {
          ...inherited,
          ...environment,
          ...(withAnthropic ? { MODEL_PROFILES_TEST_API_KEY: "set" } : {}),
          MODEL_PROFILES_SERVER: new URL("../src/server.ts", import.meta.url)
            .href,
          MODEL_PROFILES_DIRECTORY: directory,
          MODEL_PROFILES_PROVIDERS: withAnthropic
            ? "anthropic,openai"
            : "openai",
        },
        timeout: 30_000,
      },
    );
    return JSON.parse(stdout) as {
      compaction: string | null;
      ranOn: string;
      reloaded: boolean;
    };
  };
  const firstWith = await startProcess(true);
  const firstWithout = await startProcess(false);
  assert.deepEqual(
    [firstWith.reloaded, firstWithout.reloaded],
    [false, true],
    "each setup checks availability once",
  );
  assert.deepEqual(
    await startProcess(true),
    { compaction: "anthropic/opus", ranOn: "anthropic/opus", reloaded: false },
    "the process with the provider still applies its ref after another setup ran",
  );
  assert.deepEqual(await startProcess(false), {
    compaction: null,
    ranOn: "openai/base",
    reloaded: false,
  });
});

test("the provider setup follows the variables providers connect with, from OpenCode's catalog when cached", async (t) => {
  const { root } = await temporaryRoot(t);
  const directories = { data: join(root, "data"), cache: join(root, "cache") };
  const key = (environment: NodeJS.ProcessEnv) =>
    providerSetupKey({}, environment, directories);
  for (const cached of [false, true]) {
    if (cached) {
      await mkdir(directories.cache, { recursive: true });
      await writeFile(
        join(directories.cache, "models.json"),
        JSON.stringify({
          "amazon-bedrock": {
            id: "amazon-bedrock",
            env: ["AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
            models: {},
          },
          local: { id: "local", env: ["LOCAL_MODELS_HOST"], models: {} },
        }),
      );
    }
    const none = await key({});
    const label = cached ? "with the catalog" : "without the catalog";
    assert.notEqual(
      await key({ AWS_BEARER_TOKEN_BEDROCK: "token" }),
      none,
      `Bedrock's token alone is a different setup ${label}`,
    );
    assert.notEqual(await key({ AWS_REGION: "eu-west-1" }), none, label);
    assert.notEqual(
      await key({ VERTEX_LOCATION: "europe-west4" }),
      none,
      label,
    );
    assert.equal(
      await key({ OPENCODE_MODEL_PROFILE: "fast" }),
      none,
      `the profile variable is not a provider setup ${label}`,
    );
    if (cached) {
      assert.notEqual(await key({ LOCAL_MODELS_HOST: "http://x" }), none);
      assert.equal(
        await key({ GITHUB_TOKEN: "token" }),
        none,
        "a variable no provider reads is ignored when the catalog lists them",
      );
    }
  }
  await writeFile(join(directories.cache, "models.json"), "{ not json");
  assert.notEqual(
    await key({ GITHUB_TOKEN: "token" }),
    await key({}),
    "an unreadable catalog falls back to matching credential-like names",
  );
});

test("saving availability moves ref models out of the old per-directory file and keeps the eight setups last used", async (t) => {
  const { root } = await temporaryRoot(t);
  const state = join(root, "state");
  const directory = join(root, "project");
  const folder = dirname(availabilityFilePath(state, directory, "current"));
  await mkdir(folder, { recursive: true });
  const prefix = basename(
    availabilityFilePath(state, directory, "current"),
  ).replace(/-current\.json$/, "");
  const legacyFile = join(folder, `${prefix}.json`);
  await writeFile(
    legacyFile,
    JSON.stringify({
      version: 1,
      models: ["other/model"],
      refModels: ["anthropic/opus"],
    }),
  );
  assert.equal(
    await knownAvailableModels(state, directory, "current"),
    undefined,
    "the old file's models are not trusted for any setup",
  );
  const otherDirectoryFile = availabilityFilePath(
    state,
    join(root, "elsewhere"),
    "old",
  );
  await writeFile(otherDirectoryFile, "{}");
  for (let index = 0; index < 10; index += 1) {
    const file = availabilityFilePath(state, directory, `old${index}`);
    await writeFile(file, JSON.stringify({ version: 1, models: [] }));
    const time = new Date(Date.UTC(2026, 0, 1 + index));
    await utimes(file, time, time);
  }
  assert.deepEqual(
    await knownAvailableModels(state, directory, "old0"),
    new Set(),
    "the oldest saved setup is loaded, as a process using it does",
  );

  await rememberAvailableModels(
    state,
    directory,
    "current",
    new Set(["openai/base"]),
  );
  const saved = JSON.parse(
    await readFile(availabilityFilePath(state, directory, "current"), "utf8"),
  ) as { models: string[]; refModels: string[] };
  assert.deepEqual(saved.models, ["openai/base"]);
  assert.deepEqual(saved.refModels, ["anthropic/opus"]);
  assert.equal(knownRefModels(directory).has("anthropic/opus"), true);
  const remaining = (await readdir(folder)).sort();
  assert.equal(
    remaining.includes(`${prefix}.json`),
    false,
    "the old file is removed",
  );
  assert.deepEqual(
    remaining.filter((name) => name.startsWith(`${prefix}-`)),
    [
      `${prefix}-current.json`,
      ...[0, 4, 5, 6, 7, 8, 9].map((index) => `${prefix}-old${index}.json`),
    ].sort(),
    "the most recently saved or loaded setups are kept",
  );
  assert.equal(remaining.includes(basename(otherDirectoryFile)), true);
});

test("the provider setup ignores credential values but not which providers have credentials", async (t) => {
  const { root } = await temporaryRoot(t);
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const key = (
    config: Record<string, unknown>,
    environment: NodeJS.ProcessEnv = {},
  ) =>
    providerSetupKey(config, environment, { data, cache: join(root, "cache") });
  const none = await key({});
  assert.notEqual(await key({ provider: { local: { models: {} } } }), none);
  assert.notEqual(await key({ disabled_providers: ["openai"] }), none);
  assert.notEqual(await key({}, { OPENAI_API_KEY: "one" }), none);
  assert.equal(
    await key({}, { OPENAI_API_KEY: "one" }),
    await key({}, { OPENAI_API_KEY: "two" }),
  );
  assert.equal(await key({}, { EDITOR: "vim" }), none);
  await writeFile(
    join(data, "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth", access: "one" } }),
  );
  const withAuth = await key({});
  assert.notEqual(withAuth, none);
  await writeFile(
    join(data, "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth", access: "refreshed" } }),
  );
  assert.equal(await key({}), withAuth, "a refreshed token keeps the setup");
});

test("a toast or log call that fails stops neither a prompt's fallback nor the reload", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    terminals: [{ id: "pty" }],
    noticesFail: true,
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  await hooks.config?.({
    model: "openai/base",
    agent: { builder: { modelRef: "reasoning" } },
  });
  assert.deepEqual(
    await sendPrompt(hooks, "builder", {
      providerID: "gone",
      modelID: "model",
    }),
    { providerID: "openai", modelID: "base" },
  );
  assert.equal(state.toasts.length, 1, "the fallback toast was tried");

  const emit = (type: string, properties: unknown = {}) =>
    hooks.event?.({ event: { type, properties } } as never);
  await emit("session.idle", { sessionID: "ses" });
  await eventually(
    () => state.toasts.length === 2,
    "the open terminal toast is tried",
  );
  state.terminals = [];
  await emit("pty.deleted", { id: "pty" });
  await eventually(
    () => state.disposals === 1,
    "the reload still runs once the terminal closes",
  );
});

test("a pending reload is retried when terminals close or a session goes idle, and a blocking terminal is toasted", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning", "title": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    terminals: [{ id: "pty_1" }],
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  const config = { model: "openai/base", agent: {} };
  await hooks.config?.(config);
  assert.deepEqual(config.agent, {
    compaction: { model: "gone/model" },
    title: { model: "gone/model" },
  });
  const emit = (type: string, properties: unknown = {}) =>
    hooks.event?.({ event: { type, properties } } as never);
  await emit("server.connected");
  await eventually(
    () => state.providerChecks === 1,
    "the first event checks availability",
  );
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await emit("session.idle", { sessionID: "ses" });
    await eventually(
      () => state.terminalChecks === attempt,
      "an idle session tries the reload",
    );
  }
  assert.equal(
    state.disposals,
    undefined,
    "no reload while a terminal is open",
  );
  assert.deepEqual(state.toasts, [
    "Built-in agents such as compaction and title keep an unavailable ref's model until the project reloads, which waits for every terminal to close.",
  ]);

  state.terminals = [];
  await emit("pty.deleted", { id: "pty_1" });
  await eventually(
    () => state.disposals === 1,
    "closing the terminal reloads the project",
  );

  const busyDirectory = join(directory, "busy");
  const busyState: FakeServerState = {
    providers: state.providers,
    toasts: [],
    busy: true,
  };
  const busyHooks = await server.server(
    {
      worktree: busyDirectory,
      directory: busyDirectory,
      client: fakeServerClient(busyState),
    } as never,
    undefined,
  );
  await busyHooks.config?.({ agent: {} });
  const emitBusy = (type: string, properties: unknown = {}) =>
    busyHooks.event?.({ event: { type, properties } } as never);
  await emitBusy("server.connected");
  await eventually(
    () => busyState.providerChecks === 1,
    "the first event checks availability",
  );
  await emitBusy("session.status", {
    sessionID: "ses",
    status: { type: "busy" },
  });
  await settle();
  assert.equal(busyState.disposals, undefined);
  busyState.busy = false;
  await emitBusy("session.status", {
    sessionID: "ses",
    status: { type: "idle" },
  });
  await eventually(
    () => busyState.disposals === 1,
    "a session reported idle reloads without waiting for session.idle",
  );
});

test("a reload the host keeps refusing stops after a few tries with a warning toast", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    disposeFails: true,
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  await hooks.config?.({ agent: {} });
  const idle = () =>
    hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses" } },
    } as never);
  // The first idle session also starts the availability check, and asks once that check ends.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await idle();
    await eventually(
      () => state.disposals === attempt,
      "each idle session asks for the reload again",
    );
  }
  await idle();
  await settle();
  assert.equal(state.disposals, 3);
  assert.deepEqual(state.toasts, [
    "OpenCode did not reload the project after 3 tries, so built-in agents such as compaction and title keep an unavailable ref's model until OpenCode restarts.",
  ]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendPrompt(hooks, "build", { providerID: "openai", modelID: "base" });
    await idle();
    await settle();
  }
  assert.equal(state.disposals, 3, "later prompts do not ask again");
});

test("an idle session reported while the first availability check runs still reloads", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning" } }',
  );
  let release: (value?: unknown) => void = () => undefined;
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    providersGate: new Promise((resolve) => {
      release = resolve;
    }),
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  await hooks.config?.({ agent: {} });
  await hooks.event?.({
    event: { type: "session.idle", properties: { sessionID: "ses" } },
  } as never);
  await eventually(
    () => state.providerChecks === 1,
    "the first event checks availability",
  );
  release();
  await eventually(
    () => state.disposals === 1,
    "the idle session reloads once the check ends",
  );
});

test("an idle moment reported twice uses one try of a refused reload", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    disposeFails: true,
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  await hooks.config?.({ agent: {} });
  await hooks.event?.({
    event: { type: "server.connected", properties: {} },
  } as never);
  await eventually(
    () => state.providerChecks === 1,
    "the first event checks availability",
  );
  await hooks.event?.({
    event: {
      type: "session.status",
      properties: { sessionID: "ses", status: { type: "idle" } },
    },
  } as never);
  await hooks.event?.({
    event: { type: "session.idle", properties: { sessionID: "ses" } },
  } as never);
  await eventually(
    () => (state.disposals ?? 0) >= 1,
    "the idle session asks for the reload",
  );
  await settle();
  assert.equal(state.disposals, 1, "the refusal is not retried at once");
});

test("a held-back or refused reload for refs that are available again says so", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "anthropic/opus" }, "builtins": { "compaction": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
  };
  const pluginInput = {
    worktree: directory,
    directory,
    client: fakeServerClient(state),
  } as never;
  const learn = await server.server(pluginInput, undefined);
  await learn.config?.({ agent: {} });
  await sendPrompt(learn, "build", { providerID: "openai", modelID: "base" });

  const hooks = await server.server(pluginInput, undefined);
  const config = { agent: {} };
  await hooks.config?.(config);
  assert.deepEqual(config.agent, {}, "the ref is left out while unavailable");
  state.providers = [
    { id: "anthropic", models: { opus: {} } },
    { id: "openai", models: { base: {} } },
  ];
  state.terminals = [{ id: "pty" }];
  state.toasts.length = 0;
  const idle = () =>
    hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "ses" } },
    } as never);
  await idle();
  await eventually(
    () => state.terminalChecks === 1,
    "the idle session tries the reload once availability is checked",
  );
  assert.deepEqual(state.toasts, [
    "Refs that are available again apply once the project reloads, which waits for every terminal to close.",
  ]);
  state.terminals = [];
  state.disposeFails = true;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await idle();
    await eventually(
      () => state.disposals === attempt,
      "each idle session asks for the reload again",
    );
  }
  assert.deepEqual(state.toasts.slice(1), [
    "OpenCode did not reload the project after 3 tries, so refs that are available again apply once OpenCode restarts.",
  ]);
});

test("a terminal that closes while a reload attempt is checking is not missed", async (t) => {
  const { directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "gone/model" }, "builtins": { "compaction": "reasoning" } }',
  );
  const state: FakeServerState = {
    providers: [{ id: "openai", models: { base: {} } }],
    toasts: [],
    terminals: [{ id: "first" }, { id: "second" }],
  };
  const hooks = await server.server(
    {
      worktree: directory,
      directory,
      client: fakeServerClient(state),
    } as never,
    undefined,
  );
  await hooks.config?.({ agent: {} });
  const ptyDeleted = (id: string) =>
    hooks.event?.({
      event: { type: "pty.deleted", properties: { id } },
    } as never);
  await hooks.event?.({
    event: { type: "server.connected", properties: {} },
  } as never);
  await eventually(
    () => state.providerChecks === 1,
    "the first event checks availability",
  );
  state.terminals = [{ id: "second" }];
  // The second terminal closes after the attempt for the first has read the list, but before it has acted on it.
  state.onTerminalList = () => {
    state.terminals = [];
    ptyDeleted("second")?.catch(() => undefined);
  };
  await ptyDeleted("first");
  await eventually(
    () => state.disposals === 1,
    "the reload runs again once the attempt that saw the second terminal ends",
  );
  assert.equal(state.terminalChecks, 2);
});

test("a model set by hand stays as OpenCode would use it, even after a ref put it on an agent", async (t) => {
  const { configFile, directory } = await serverProject(
    t,
    '{ "defaults": { "reasoning": "anthropic/opus" } }',
  );
  const state: FakeServerState = {
    providers: [
      { id: "anthropic", models: { opus: {} } },
      { id: "openai", models: { base: {} } },
    ],
    toasts: [],
  };
  const pluginInput = {
    worktree: directory,
    directory,
    client: fakeServerClient(state),
  } as never;
  const opus = { providerID: "anthropic", modelID: "opus" };
  const base = { providerID: "openai", modelID: "base" };

  const withRef = await server.server(pluginInput, undefined);
  await withRef.config?.({
    model: "openai/base",
    agent: { reviewer: { modelRef: "reasoning" } },
  });
  assert.deepEqual(await sendPrompt(withRef, "reviewer", opus), opus);

  await writeFile(configFile, '{ "defaults": {} }');
  state.providers = [{ id: "openai", models: { base: {} } }];
  const handSet = await server.server(pluginInput, undefined);
  await handSet.config?.({
    model: "openai/base",
    agent: { reviewer: { model: "anthropic/opus" } },
  });
  assert.deepEqual(
    await sendPrompt(handSet, "reviewer", opus),
    opus,
    "the agent's own model is not moved",
  );
  assert.deepEqual(
    await sendPrompt(handSet, "plan", opus),
    base,
    "a session that still asks for the ref's old model is moved",
  );

  await writeFile(
    configFile,
    '{ "defaults": { "reasoning": "anthropic/opus" } }',
  );
  const shared = await server.server(pluginInput, undefined);
  await shared.config?.({
    model: "anthropic/opus",
    agent: {
      reviewer: { model: "anthropic/opus" },
      builder: { modelRef: "reasoning" },
    },
  });
  assert.deepEqual(
    await sendPrompt(shared, "reviewer", opus),
    opus,
    "another agent's ref on the same model does not move a hand-set one",
  );
  assert.deepEqual(
    await sendPrompt(shared, "explore", opus),
    opus,
    "the top-level model set by hand is not moved",
  );
  assert.deepEqual(await sendPrompt(shared, "builder", opus), base);
});

test("the dialog marks refs the server found unavailable, and the TUI does not warn about them twice", () => {
  const refs = [
    {
      ref: "reasoning",
      model: "gone/model",
      source: "defaults" as const,
      unavailable: true as const,
      agents: ["builder"],
    },
  ];
  const options = modelConfigOptions({
    report: { ...dialogReport, refs },
    profiles: [],
    savedProfile: undefined,
    defaultProfile: undefined,
    notices: [],
  });
  const row = options.find((option) => option.value === "ref:reasoning");
  assert.deepEqual(
    [row?.title, row?.footer],
    ["reasoning → gone/model, unavailable, OpenCode's model", "fallback"],
  );
  assert.deepEqual(
    unavailableModelNotices(refs, [{ id: "openai", models: {} }]),
    [],
  );
});

const pendingPickWait = 800;
const waitFor = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fakeTui(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "model-profiles-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = {
    version: 1,
    configFile: join(root, "models.jsonc"),
    selectionFile: join(root, "selection.json"),
    worktree: root,
    profiles: ["fast"],
    profile: null as string | null,
    profileSource: "none",
    refs: [],
    notices: [],
  };
  const state = {
    busy: false,
    terminals: [] as unknown[],
    disposals: 0,
    toasts: [] as string[],
    /** How many terminal lists were answered. */
    terminalChecks: 0,
    disposeFails: false,
    terminalListFails: false,
    /** Runs once, the next time the terminals are listed, while that list is still on its way. */
    onTerminalList: undefined as (() => void) | undefined,
  };
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const disposers: (() => void)[] = [];
  let command: { run: () => void } | undefined;
  let dialog: { onSelect: (option: { value: string }) => void } | undefined;
  const api = {
    state: {
      provider: [{ id: "openai", models: {} }],
      path: { directory: root, worktree: root },
    },
    client: {
      config: {
        get: () =>
          Promise.resolve({
            data: { plugin: [[packageName, { modelProfilesReport: report }]] },
          }),
      },
      session: {
        status: () =>
          Promise.resolve({
            data: { ses: { type: state.busy ? "busy" : "idle" } },
          }),
      },
      pty: {
        list: () => {
          const terminals = [...state.terminals];
          const fails = state.terminalListFails;
          const listed = state.onTerminalList;
          state.onTerminalList = undefined;
          listed?.();
          return new Promise((resolve) =>
            setTimeout(() => {
              state.terminalChecks += 1;
              resolve(fails ? { error: "unavailable" } : { data: terminals });
            }, 0),
          );
        },
      },
      instance: {
        dispose: () => {
          state.disposals += 1;
          if (state.disposeFails) {
            return Promise.resolve({ error: "refused" });
          }
          report.profile = "fast";
          return Promise.resolve({ data: true });
        },
      },
    },
    keymap: {
      registerLayer: (layer: { commands: { run: () => void }[] }) => {
        command = layer.commands[0];
        return () => undefined;
      },
    },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        return () => undefined;
      },
    },
    lifecycle: {
      onDispose: (dispose: () => void) => {
        disposers.push(dispose);
        return () => undefined;
      },
    },
    ui: {
      toast: ({ message }: { message: string }) => state.toasts.push(message),
      dialog: {
        replace: (render: () => typeof dialog) => {
          dialog = render();
        },
        clear: () => undefined,
        setSize: () => undefined,
      },
      DialogSelect: (props: typeof dialog) => props,
    },
  };
  await tui.tui(api as never, undefined, {} as never);
  t.after(() => {
    for (const dispose of disposers) {
      dispose();
    }
  });
  const emit = async (type: string, properties: unknown = {}) => {
    for (const handler of handlers.get(type) ?? []) {
      handler({ type, properties });
    }
    await settle();
  };
  const openDialog = () => dialog;
  const pick = async (value: string) => {
    dialog = undefined;
    command?.run();
    // The dialog opens once the models file and saved pick are read from disk.
    await eventually(() => openDialog() !== undefined, "the dialog opens");
    openDialog()?.onSelect({ value });
    await settle();
  };
  return { root, report, state, emit, pick };
}

test("a profile picked while a terminal is open applies once the terminals close, without ending them", async (t) => {
  const { state, emit, pick } = await fakeTui(t);
  state.terminals = [{ id: "pty_dev_server" }];
  await pick("profile:fast");
  await eventually(
    () => state.terminalChecks === 1,
    "the pick checks the terminals",
  );
  assert.equal(state.disposals, 0, "a reload would end the open terminal");
  assert.deepEqual(state.toasts.slice(-1), [
    "Saved fast for this worktree. Reloading would end the open terminals, so it applies once they are all closed.",
  ]);
  await emit("pty.exited", { id: "pty_dev_server", exitCode: 0 });
  await eventually(
    () => state.terminalChecks === 2,
    "an exited terminal checks the terminals again",
  );
  assert.equal(state.disposals, 0, "the terminal is still listed");

  state.terminals = [];
  await emit("pty.deleted", { id: "pty_dev_server" });
  await eventually(
    () => state.toasts.at(-1) === "Using fast.",
    "closing the terminal applies the pick",
  );
  assert.equal(state.disposals, 1);
  await emit("session.idle", { sessionID: "ses" });
  await waitFor(pendingPickWait);
  assert.equal(state.disposals, 1, "an applied pick does not reload again");
});

test("a profile picked while a session is busy applies when it goes idle, or with any other reload", async (t) => {
  const { root, state, emit, pick } = await fakeTui(t);
  state.busy = true;
  await pick("profile:fast");
  await eventually(
    () => state.toasts.length === 1,
    "the pick says it waits for the session",
  );
  assert.equal(state.disposals, 0);
  state.busy = false;
  await emit("session.status", {
    sessionID: "ses",
    status: { type: "idle" },
  });
  await eventually(
    () => state.disposals === 1,
    "the idle session applies the pick",
  );

  state.terminals = [{ id: "pty" }];
  await pick("defaults");
  await eventually(
    () => state.terminalChecks === 2,
    "the second pick checks the terminals",
  );
  await emit("server.instance.disposed", { directory: root });
  await eventually(
    () => state.toasts.at(-1) === "Using fast.",
    "a reload from elsewhere applies the saved pick and says what is in use",
  );
  state.terminals = [];
  await emit("pty.deleted", { id: "pty" });
  await waitFor(pendingPickWait);
  assert.equal(state.disposals, 1, "the pick no longer waits");
});

test("a pending pick leaves the reload to the server plugin when it reloads at the same moment", async (t) => {
  const { root, report, state, emit, pick } = await fakeTui(t);
  state.busy = true;
  await pick("profile:fast");
  await eventually(
    () => state.toasts.length === 1,
    "the pick says it waits for the session",
  );
  state.busy = false;
  await emit("session.idle", { sessionID: "ses" });
  report.profile = "fast";
  await emit("server.instance.disposed", { directory: root });
  await eventually(
    () => state.toasts.at(-1) === "Using fast.",
    "the server's reload applies the pick",
  );
  await waitFor(pendingPickWait);
  assert.equal(state.disposals, 0, "the project reloads once, not twice");
});

test("a pending pick OpenCode refuses to reload for is not retried by the same idle moment", async (t) => {
  const { state, emit, pick } = await fakeTui(t);
  state.busy = true;
  await pick("profile:fast");
  await eventually(
    () => state.toasts.length === 1,
    "the pick says it waits for the session",
  );
  state.busy = false;
  state.disposeFails = true;
  await emit("session.status", {
    sessionID: "ses",
    status: { type: "idle" },
  });
  await emit("session.idle", { sessionID: "ses" });
  await eventually(
    () => state.disposals >= 1,
    "the idle session applies the pick",
  );
  await waitFor(pendingPickWait);
  assert.equal(state.disposals, 1);
  assert.deepEqual(state.toasts.slice(-1), [
    "Saved fast, but OpenCode did not reload. It applies on the next reload.",
  ]);
});

test("a terminal list that fails holds a pick back with a warning, and a pending pick waits for the next event", async (t) => {
  const { state, emit, pick } = await fakeTui(t);
  state.terminalListFails = true;
  await pick("profile:fast");
  await eventually(
    () => state.terminalChecks === 1,
    "the pick checks the terminals",
  );
  assert.equal(state.disposals, 0);
  assert.deepEqual(state.toasts.slice(-1), [
    "Saved fast for this worktree, but OpenCode could not report whether a terminal is open, so it did not reload. It applies on the next reload.",
  ]);

  state.terminalListFails = false;
  state.busy = true;
  await pick("profile:fast");
  await eventually(
    () => state.toasts.length === 2,
    "the pick says it waits for the session",
  );
  state.busy = false;
  state.terminalListFails = true;
  await emit("session.idle", { sessionID: "ses" });
  await eventually(
    () => state.terminalChecks === 2,
    "the idle session checks the terminals",
  );
  assert.equal(state.disposals, 0, "the pick stays pending");
  state.terminalListFails = false;
  await emit("pty.deleted", { id: "pty" });
  await eventually(
    () => state.disposals === 1,
    "the next event applies the pick",
  );
});

test("a newer pick replaces a pending one, so the project reloads once", async (t) => {
  const { state, emit, pick } = await fakeTui(t);
  state.busy = true;
  await pick("profile:fast");
  await pick("defaults");
  await eventually(
    () => state.toasts.length === 2,
    "both picks say they wait for the session",
  );
  state.busy = false;
  await emit("session.idle", { sessionID: "ses" });
  await eventually(() => state.disposals === 1, "the idle session applies it");
  await emit("session.idle", { sessionID: "ses" });
  await waitFor(pendingPickWait);
  assert.equal(state.disposals, 1);
});

test("a terminal that closes while a pending pick is checking is not missed", async (t) => {
  const { state, emit, pick } = await fakeTui(t);
  state.terminals = [{ id: "second" }, { id: "first" }];
  await pick("profile:fast");
  await eventually(
    () => state.terminalChecks === 1,
    "the pick checks the terminals",
  );
  state.terminals = [{ id: "second" }];
  state.onTerminalList = () => {
    state.terminals = [];
    emit("pty.deleted", { id: "second" }).catch(() => undefined);
  };
  await emit("pty.deleted", { id: "first" });
  await eventually(
    () => state.disposals === 1,
    "the check runs again once the attempt that saw the second terminal ends",
  );
  assert.equal(state.terminalChecks, 3);
});
