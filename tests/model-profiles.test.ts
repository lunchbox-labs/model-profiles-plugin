import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { modelsFilePath, resolveModelProfiles } from "../src/apply.ts";
import { modelConfigOptions } from "../src/model-config-view.ts";
import { builtInAgentNames, parseModelsDocument } from "../src/models-file.ts";
import { packageName, publishReport, readReport } from "../src/report.ts";
import { applyModelRefs, selectProfile } from "../src/resolution.ts";
import {
  processProfile,
  readSavedSelection,
  saveSelection,
  selectionFilePath,
  stateDirectory,
} from "../src/selection.ts";
import server from "../src/server.ts";

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

test("built-in agents take refs from builtins unless they set their own, and others keep OpenCode's default", () => {
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
  const unknown = selectProfile(document, "gone", undefined);
  assert.equal(unknown.profile, null);
  assert.match(unknown.notices[0] ?? "", /"gone" from OPENCODE_MODEL_PROFILE/);
  assert.match(
    selectProfile(document, undefined, "gone").notices[0] ?? "",
    /saved worktree selection/,
  );
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
    const report = await resolveModelProfiles(config, {
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
  const environment = { OPENCODE_CONFIG_DIR: "/config/opencode" };
  assert.equal(
    modelsFilePath(undefined, environment),
    join("/config/opencode", "models.jsonc"),
  );
  assert.equal(
    modelsFilePath({ configFile: "models/work.jsonc" }, environment),
    join("/config/opencode", "models", "work.jsonc"),
  );
  assert.equal(
    modelsFilePath({ configFile: "/elsewhere/models.jsonc" }, environment),
    join("/elsewhere", "models.jsonc"),
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
  const report = await resolveModelProfiles(config, {
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

  const saved = await resolveModelProfiles(
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

test("the /model-config dialog lists profiles with the current one marked, refs with their agents, and fallbacks", () => {
  const options = modelConfigOptions(
    {
      version: 1,
      configFile: "/c/models.jsonc",
      selectionFile: "/s/x.json",
      worktree: "/w",
      profiles: ["primary"],
      profile: "primary",
      profileSource: "environment",
      environmentProfile: "primary",
      refs: [
        {
          ref: "coding",
          model: "openai/gpt-5.6-sol",
          variant: "medium",
          source: "profile",
          agents: ["general"],
        },
        { ref: "missing", source: "unresolved", agents: ["helper"] },
      ],
      notices: ["Something fell back."],
    },
    ["primary", "fast"],
  );
  assert.deepEqual(
    options.map((option) => [option.title, option.value, option.footer]),
    [
      ["Defaults only", "defaults", undefined],
      ["primary", "profile:primary", "current"],
      ["fast", "profile:fast", undefined],
      ["coding → openai/gpt-5.6-sol (medium)", "ref:coding", "profile"],
      ["missing → not defined, OpenCode's model", "ref:missing", "fallback"],
      ["Something fell back.", "notice:0", undefined],
    ],
  );
  assert.match(
    options[0]?.category ?? "",
    /OPENCODE_MODEL_PROFILE=primary overrides/,
  );
  assert.equal(options[3]?.description, "general");
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
