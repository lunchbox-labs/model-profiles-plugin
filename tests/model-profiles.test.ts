import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { modelsFilePath, resolveModelProfiles } from "../src/apply.ts";
import {
  assignmentsAreStale,
  availableModels,
  fallbackModel,
  readConnectedProviders,
} from "../src/fallback.ts";
import {
  fallbackToastLines,
  modelConfigOptions,
  selectedChoice,
  selectedNotice,
  unavailableModelNotices,
} from "../src/model-config-view.ts";
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

test("a fallback uses the agent's own model, then OpenCode's configured, recent or provider default model", () => {
  const assignment = {
    agent: "builder",
    ref: "reasoning",
    model: "gone/model",
    applied: true,
  };
  const connected = {
    providers: [
      { id: "anthropic", models: { "claude-haiku-5-5": {} } },
      { id: "openai", models: { "gpt-6-astra": {}, own: {}, recent: {} } },
    ],
    default: { anthropic: "claude-haiku-5-5", openai: "gpt-6-astra" },
  };
  const available = availableModels(connected);
  const base = {
    assignment,
    available,
    connected,
    configuredProviders: [],
    recent: [],
  };
  assert.deepEqual(
    fallbackModel({
      ...base,
      assignment: { ...assignment, ownModel: "openai/own", ownVariant: "low" },
      configuredModel: "openai/gpt-6-astra",
    }),
    { providerID: "openai", modelID: "own", variant: "low" },
  );
  assert.deepEqual(
    fallbackModel({
      ...base,
      assignment: { ...assignment, ownModel: "gone/own" },
      configuredModel: "openai/gpt-6-astra",
    }),
    { providerID: "openai", modelID: "gpt-6-astra" },
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
  });
  const calls: string[] = [];
  let busy = true;
  const client = {
    config: {
      providers: () =>
        Promise.resolve({
          data: {
            providers: [
              { id: "openai", models: { "gpt-6-astra": {}, base: {} } },
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
    },
    instance: {
      dispose: () => {
        calls.push("dispose");
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
  await hooks["chat.message"]?.({} as never, { message, parts: [] } as never);
  assert.deepEqual(message.model, { providerID: "openai", modelID: "base" });

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
  assert.deepEqual(calls, ["dispose"]);

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
    agent: "builder",
    model: { providerID: "gone", modelID: "model" },
  };
  await reloaded["chat.message"]?.(
    {} as never,
    { message: remembered, parts: [] } as never,
  );
  assert.deepEqual(
    remembered.model,
    { providerID: "openai", modelID: "base" },
    "a session that still remembers the unavailable model moves off it after the reload",
  );
  await reloaded.event?.({
    event: { type: "session.idle", properties: { sessionID: "ses" } },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["dispose"], "a consistent project does not reload");
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
