import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateRelease as validate } from "../scripts/validate-release.mjs";
import {
  main,
  maxConsecutiveErrors,
  pollIntervalMs,
  releaseCiState,
  waitForReleaseCi,
} from "../scripts/release-ci.mjs";

const release = {
  name: "@lunchbox-labs/opencode-model-profiles",
  version: "1.2.3",
  repository: {
    url: "git+https://github.com/lunchbox-labs/opencode-model-profiles.git",
  },
  publishConfig: { access: "public" },
};

const lock = {
  name: release.name,
  version: release.version,
  packages: { "": { name: release.name, version: release.version } },
};
const validateRelease = (manifest, tag) => validate(manifest, tag, lock);

test("release validation rejects stale or missing lockfile versions", () => {
  for (const broken of [
    undefined,
    { ...lock, version: "1.2.2" },
    { ...lock, packages: { "": { name: release.name, version: "1.2.2" } } },
  ]) {
    assert.throws(() => validate(release, "v1.2.3", broken), /lockfile/);
  }
});

test("release validation accepts explicit public and scoped restricted stable releases", () => {
  assert.deepEqual(validateRelease(release, "v1.2.3"), {
    name: release.name,
    version: "1.2.3",
    access: "public",
  });
  assert.equal(
    validateRelease(
      { ...release, publishConfig: { access: "restricted" } },
      "v1.2.3",
    ).access,
    "restricted",
  );
});

test("release validation rejects private, provisional, mismatched, prerelease, and misrouted packages", () => {
  for (const change of [
    { private: true },
    { private: "false" },
    { name: "package-name-tbd" },
    { name: "invalid name" },
    { name: "opencode-model-profiles" },
    { name: "@other/opencode-model-profiles" },
    { version: "0.0.0" },
    { version: "1.2.3-beta.1" },
    { version: "01.2.3" },
    { publishConfig: undefined },
    { publishConfig: { access: "other" } },
    { name: "unscoped", publishConfig: { access: "restricted" } },
    {
      publishConfig: { access: "public", registry: "https://example.invalid" },
    },
    { repository: { url: "git+https://github.com/example/other.git" } },
  ]) {
    assert.throws(() => validateRelease({ ...release, ...change }, "v1.2.3"));
  }
  for (const tag of [
    undefined,
    "1.2.3",
    "v1.2.4",
    "main",
    "v1.2.3;echo unexpected",
  ]) {
    assert.throws(() => validateRelease(release, tag), /release tag/);
  }
});

test("a manual run on main verifies the package.json version before npm publication", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.name, "Publish");
  assert.equal(workflow["run-name"], undefined);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /inputs\.|github\.event\.|github\.ref_name/,
  );
  assert.deepEqual(Object.keys(workflow.jobs), [
    "checks",
    "verify",
    "publish",
    "release",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const { checks, verify, publish, release } = workflow.jobs;
  assert.equal(verify.name, "Verify");
  assert.equal(publish.name, "Publish npm");
  assert.equal(release.name, "Draft GitHub release");
  assert.equal(verify.needs, undefined);
  assert.equal(verify.environment, undefined);
  assert.equal(
    verify.if.replace(/\s+/g, " ").trim(),
    "github.repository == 'lunchbox-labs/opencode-model-profiles' && github.event_name == 'workflow_dispatch'",
  );
  assert.equal(checks.if, verify.if);
  assert.deepEqual(checks.needs, ["verify"]);
  assert.equal(verify.steps[0].name, "Require a run on main");
  assert.deepEqual(verify.steps[0].env, { RUN_REF: "${{ github.ref }}" });
  assert.deepEqual(verify.outputs, {
    access: "${{ steps.release.outputs.access }}",
    name: "${{ steps.release.outputs.name }}",
    tag: "${{ steps.version.outputs.tag }}",
    version: "${{ steps.release.outputs.version }}",
  });
  for (const job of [checks, verify]) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
  }
  assert.ok(
    verify.steps.some(
      (step) =>
        step.env?.WORKFLOW_COMMIT === "${{ github.sha }}" &&
        step.run.includes("git rev-parse HEAD"),
    ),
  );
  const version = verify.steps.findIndex((step) => step.id === "version");
  const validate = verify.steps.findIndex(
    (step) => step.run === "node scripts/validate-release.mjs",
  );
  const refuse = verify.steps.findIndex(
    (step) => step.name === "Refuse a version that is already released",
  );
  assert.ok(version >= 0 && validate > version && refuse > validate);
  assert.match(verify.steps[version].run, /jq -r \.version package\.json/);
  assert.match(verify.steps[version].run, /echo "tag=v\$version"/);
  assert.match(verify.steps[version].run, /GITHUB_STEP_SUMMARY/);
  assert.equal(
    verify.steps[validate].env.RELEASE_TAG,
    "${{ steps.version.outputs.tag }}",
  );
  assert.deepEqual(verify.steps[refuse].env, {
    NPM_PACKAGE: "${{ steps.release.outputs.name }}",
    NPM_VERSION: "${{ steps.release.outputs.version }}",
    RELEASE_TAG: "${{ steps.version.outputs.tag }}",
  });
  let previous = refuse;
  for (const command of ["npm ci", "npm run check", "npm run test:package"]) {
    const index = verify.steps.findIndex((step) => step.run === command);
    assert.ok(index > previous);
    previous = index;
  }
  const upload = verify.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.with.path, "release/");
  for (const job of [publish, release]) {
    const download = job.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    assert.equal(upload.with.name, download.with.name);
    assert.equal(download.with.path, "release");
  }
  const pack = verify.steps.findIndex((step) =>
    step.run?.includes("npm pack --ignore-scripts --pack-destination release"),
  );
  assert.ok(pack > previous);
  assert.match(verify.steps[pack].run, /sha256sum/);
  assert.ok(
    verify.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ) > pack,
  );
  assert.deepEqual(publish.needs, ["checks", "verify"]);
  assert.deepEqual(checks.permissions, { contents: "read", actions: "read" });
  const gateIndex = checks.steps.findIndex(
    (step) => step.run === "node scripts/release-ci.mjs",
  );
  assert.equal(checks.steps[gateIndex].env.REQUIRED_WORKFLOWS, "Check");
  assert.equal(publish.environment, "npm");
  assert.deepEqual(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  const npm = publish.steps.find((step) => step.run?.includes("npm publish"));
  assert.equal(npm.workingDirectory, undefined);
  assert.equal(npm["working-directory"], "release");
  assert.deepEqual(npm.env, {
    NPM_ACCESS: "${{ needs.verify.outputs.access }}",
    NPM_PACKAGE: "${{ needs.verify.outputs.name }}",
    NPM_VERSION: "${{ needs.verify.outputs.version }}",
    NPM_CONFIG_PROVENANCE: "true",
  });
  const order = [
    "sha256sum --check SHA256SUMS",
    'npm view "$NPM_PACKAGE@$NPM_VERSION" dist.integrity',
    "npm publish",
  ].map((text) => npm.run.indexOf(text));
  assert.ok(
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
  );
  assert.match(
    npm.run,
    /npm publish \.\/\*\.tgz --ignore-scripts --access "\$NPM_ACCESS" --tag latest/,
  );
  assert.deepEqual(release.needs, ["verify", "publish"]);
  assert.equal(release.environment, undefined);
  assert.deepEqual(release.permissions, { contents: "write" });
  const draft = release.steps.find((step) =>
    step.run?.includes("gh release create"),
  );
  assert.equal(draft["working-directory"], "release");
  assert.deepEqual(draft.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
    RELEASE_COMMIT: "${{ github.sha }}",
    RELEASE_TAG: "${{ needs.verify.outputs.tag }}",
  });
  assert.ok(
    draft.run.indexOf("sha256sum --check SHA256SUMS") <
      draft.run.indexOf("gh release create"),
  );
  assert.match(
    draft.run,
    /gh release create "\$RELEASE_TAG" \.\/\*\.tgz --draft --target "\$RELEASE_COMMIT" --generate-notes --title "\$RELEASE_TAG"/,
  );
  assert.doesNotMatch(draft.run, /--verify-tag/);
  assert.match(
    draft.run,
    /gh release upload "\$RELEASE_TAG" \.\/\*\.tgz --clobber/,
  );
  assert.doesNotMatch(
    draft.run,
    /gh release (edit|delete)|git (tag|push)|git\/refs/,
  );
  assert.ok(
    !release.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    "the job that can write to the repository runs no repository code",
  );
});

test("publish workflow grants OIDC only to npm publication and repository writes only to the draft release job", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const source = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  assert.doesNotMatch(source, /secrets\.|vars\./);
  const allowed = new Set([
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  ]);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.environment, jobName === "publish" ? "npm" : undefined);
    assert.equal(
      job.permissions?.contents ?? workflow.permissions.contents,
      jobName === "release" ? "write" : "read",
    );
    assert.equal(
      job.permissions?.["id-token"],
      jobName === "publish" ? "write" : undefined,
    );
    assert.doesNotMatch(
      JSON.stringify(job.outputs ?? {}),
      /token|secrets\.|vars\./,
    );
    for (const step of job.steps) {
      if (step.uses) {
        assert.ok(allowed.has(step.uses));
      }
    }
  }
});

const REQUIRED = ["Check"];
const TRIGGERING_WORKFLOWS = { Check: "check.yml" };

const sha = "0123456789abcdef0123456789abcdef01234567";
const runOf = (name, fields = {}) => ({
  id: 100,
  name,
  event: "push",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  created_at: "2026-11-01T22:40:00Z",
  ...fields,
});
const passing = REQUIRED.map((name, index) => runOf(name, { id: 100 + index }));

test("release commit checks accept only the latest push run of every required workflow", () => {
  const [first] = REQUIRED;
  const others = passing.filter((run) => run.name !== first);
  const state = (runs) => releaseCiState([...others, ...runs], REQUIRED);
  assert.equal(state([runOf(first)]).state, "success");
  assert.equal(
    state([runOf(first, { status: "in_progress", conclusion: null })]).state,
    "pending",
  );
  assert.equal(releaseCiState([], REQUIRED).state, "pending");
  assert.equal(
    state([runOf(first, { event: "pull_request" })]).state,
    "pending",
  );
  assert.equal(
    state([
      runOf(first, { run_attempt: 2, status: "in_progress", conclusion: null }),
    ]).state,
    "pending",
    "an in-progress re-run of the latest run keeps the gate pending",
  );
  const laterRunDecides =
    "the run with the highest id decides, whatever its created_at says";
  const failed = state([
    runOf(first, {
      id: 900,
      conclusion: "success",
      created_at: "2026-11-01T23:59:00Z",
    }),
    runOf(first, {
      id: 901,
      conclusion: "failure",
      created_at: "2026-11-01T22:00:00Z",
    }),
  ]);
  assert.equal(failed.state, "failure", laterRunDecides);
  assert.match(failed.detail, new RegExp(`${first} \\(failure\\)`));
  assert.deepEqual(failed.cancelled, []);
  assert.equal(
    state([
      runOf(first, {
        id: 901,
        conclusion: "success",
        created_at: "2026-11-01T22:00:00Z",
      }),
      runOf(first, {
        id: 900,
        conclusion: "failure",
        created_at: "2026-11-01T23:59:00Z",
      }),
    ]).state,
    "success",
    laterRunDecides,
  );
  const cancelled = state([runOf(first, { conclusion: "cancelled" })]);
  assert.equal(cancelled.state, "failure");
  assert.deepEqual(cancelled.cancelled, [first]);
  assert.equal(
    state([runOf(first, { conclusion: "skipped" })]).state,
    "failure",
  );
  const unrequiredWorkflowsNeverDecide =
    "workflows the gate does not require never decide it";
  assert.equal(
    releaseCiState(
      [...passing, runOf("Unrelated", { id: 999, conclusion: "failure" })],
      REQUIRED,
    ).state,
    "success",
    unrequiredWorkflowsNeverDecide,
  );
  assert.equal(
    state([runOf("Unrelated", { id: 999 })]).state,
    "pending",
    unrequiredWorkflowsNeverDecide,
  );
});

function fakeGitHub(replies) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    assert.ok(replies.length > 0, "no reply left for this request");
    const reply = replies.shift();
    if (reply instanceof Error) {
      throw reply;
    }
    const { status = 200, headers = {}, runs = [] } = reply;
    return new Response(JSON.stringify({ workflow_runs: runs }), {
      status,
      headers,
    });
  };
  return { fetch, requests, replies };
}

function fakeClock() {
  let time = Date.parse("2026-11-02T10:00:00Z");
  const sleeps = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

async function waitWith(replies, options = {}) {
  const github = fakeGitHub(replies);
  const clock = fakeClock();
  const logs = [];
  const outcome = await waitForReleaseCi({
    api: "https://api.github.example",
    repository: "lunchbox-labs/example",
    sha,
    token: "test-token",
    required: REQUIRED,
    fetch: github.fetch,
    sleep: clock.sleep,
    now: clock.now,
    log: (line) => logs.push(line),
    ...options,
  });
  return { outcome, logs, requests: github.requests, sleeps: clock.sleeps };
}

const pendingRuns = passing.map((run, index) =>
  index === 0 ? { ...run, status: "queued", conclusion: null } : run,
);

test("the release commit gate lists the commit's push runs with a request timeout", async () => {
  const { outcome, requests } = await waitWith([{ runs: passing }]);
  assert.equal(outcome, "success");
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(
    url.origin + url.pathname,
    "https://api.github.example/repos/lunchbox-labs/example/actions/runs",
  );
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    head_sha: sha,
    event: "push",
    per_page: "100",
  });
  assert.equal(requests[0].init.headers.authorization, "Bearer test-token");
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test("the release commit gate polls while runs are pending and stops on success", async () => {
  const { outcome, requests, sleeps, logs } = await waitWith([
    { runs: pendingRuns },
    { runs: pendingRuns },
    { runs: passing },
  ]);
  assert.equal(outcome, "success");
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [pollIntervalMs, pollIntervalMs]);
  assert.match(logs.at(-1), /^Passed: /);
});

test("the release commit gate fails on a failed run and hints at re-running a cancelled one", async () => {
  const failed = await waitWith([
    { runs: [{ ...passing[0], conclusion: "failure" }, ...passing.slice(1)] },
  ]);
  assert.equal(failed.outcome, "failure");
  assert.deepEqual(failed.sleeps, []);
  assert.ok(!failed.logs.some((line) => line.startsWith("Hint:")));
  const cancelled = await waitWith([
    { runs: [{ ...passing[0], conclusion: "cancelled" }, ...passing.slice(1)] },
  ]);
  assert.equal(cancelled.outcome, "failure");
  assert.equal(
    cancelled.logs.at(-1),
    `Hint: re-run ${REQUIRED[0]} for the release commit, then re-run Publish.`,
  );
});

test("the release commit gate times out at the deadline", async () => {
  const { outcome, requests, logs } = await waitWith(
    Array.from({ length: 10 }, () => ({ runs: pendingRuns })),
    { waitMinutes: 1 },
  );
  assert.equal(outcome, "timeout");
  assert.equal(
    requests.length,
    3,
    "polls at 0, 30 and 60 seconds; the last one is at the deadline",
  );
  assert.equal(logs.at(-1), "Timed out waiting for the release commit checks.");
});

test("the release commit gate keeps waiting through transient API errors", async () => {
  const { outcome, requests, logs } = await waitWith([
    { status: 502 },
    new TypeError("fetch failed"),
    { status: 429 },
    { status: 403, headers: { "retry-after": "60" } },
    { runs: pendingRuns },
    { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    { status: 500 },
    { status: 503 },
    { runs: passing },
  ]);
  assert.equal(outcome, "success");
  assert.equal(requests.length, 10);
  assert.equal(
    logs.filter((line) => line.endsWith("Polling again.")).length,
    8,
  );
});

test("the release commit gate fails after five consecutive transient errors", async () => {
  const { outcome, requests, logs } = await waitWith(
    Array.from({ length: 10 }, () => ({ status: 503 })),
  );
  assert.equal(outcome, "error");
  assert.equal(requests.length, maxConsecutiveErrors);
  assert.match(logs.at(-1), /Giving up after 5 consecutive errors\.$/);
});

test("the release commit gate fails at once on errors a retry cannot fix", async () => {
  for (const reply of [
    { status: 404 },
    { status: 401 },
    { status: 403 },
    { status: 422 },
  ]) {
    const { outcome, requests, sleeps, logs } = await waitWith([
      reply,
      { runs: passing },
    ]);
    assert.equal(outcome, "error", String(reply.status));
    assert.equal(requests.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(
      logs.at(-1),
      `Listing workflow runs failed with HTTP ${reply.status}.`,
    );
  }
});

test("the release commit gate reads its settings from the environment", async () => {
  const env = {
    GITHUB_API_URL: "https://api.github.example",
    GITHUB_REPOSITORY: "lunchbox-labs/example",
    GITHUB_SHA: sha,
    GITHUB_TOKEN: "test-token",
    REQUIRED_WORKFLOWS: REQUIRED.join(" , "),
  };
  const run = async (replies, overrides = {}) => {
    const github = fakeGitHub(replies);
    const clock = fakeClock();
    const ok = await main(
      { ...env, ...overrides },
      { ...clock, fetch: github.fetch, log: () => {} },
    );
    return { ok, requests: github.requests };
  };
  const passed = await run([{ runs: passing }]);
  assert.equal(passed.ok, true);
  assert.match(
    passed.requests[0].url,
    /^https:\/\/api\.github\.example\/repos\/lunchbox-labs\/example\//,
  );
  assert.equal((await run([{ status: 404 }])).ok, false);
  assert.equal(
    (
      await run(
        Array.from({ length: 4 }, () => ({ runs: pendingRuns })),
        { WAIT_MINUTES: "1" },
      )
    ).ok,
    false,
  );
  for (const broken of [
    { GITHUB_SHA: "main" },
    { GITHUB_TOKEN: "" },
    { REQUIRED_WORKFLOWS: " , " },
    { WAIT_MINUTES: "forty" },
  ]) {
    await assert.rejects(run([], broken), /Set GITHUB_REPOSITORY/);
  }
});

async function workflowFile(name) {
  const source = await readFile(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );
  return { source, workflow: parseYaml(source) };
}

test("the release commit gate names workflows that run on every push to main", async () => {
  const { workflow: publish } = await workflowFile("publish.yml");
  const gate = publish.jobs.checks.steps.find(
    (step) => step.run === "node scripts/release-ci.mjs",
  );
  assert.deepEqual(
    gate.env.REQUIRED_WORKFLOWS.split(","),
    Object.keys(TRIGGERING_WORKFLOWS),
  );
  for (const [name, file] of Object.entries(TRIGGERING_WORKFLOWS)) {
    const { workflow } = await workflowFile(file);
    assert.equal(workflow.name, name, file);
    assert.ok(workflow.on.push.branches.includes("main"), file);
    for (const filter of ["branches-ignore", "paths", "paths-ignore"]) {
      assert.equal(
        workflow.on.push[filter],
        undefined,
        `${file} push ${filter}`,
      );
    }
  }
});

// Where the workflow mentions the GitHub token: the workflow, a job or a step.
function tokenLocations(workflow) {
  const holds = (value) =>
    /github\.token|\bGITHUB_TOKEN\b|\bGH_TOKEN\b/.test(JSON.stringify(value));
  const { jobs, ...top } = workflow;
  const locations = holds(top) ? ["workflow"] : [];
  for (const [id, { steps = [], ...job }] of Object.entries(jobs)) {
    if (holds(job)) {
      locations.push(id);
    }
    steps.forEach((step, index) => {
      if (holds(step)) {
        locations.push(`${id}.steps.${index}`);
      }
    });
  }
  return locations;
}

test("only the release commit gate and draft release steps receive the GitHub token", async () => {
  const { source, workflow } = await workflowFile("publish.yml");
  const { checks, release } = workflow.jobs;
  const checkout = checks.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["persist-credentials"], false);
  const gate = checks.steps.findIndex(
    (step) => step.run === "node scripts/release-ci.mjs",
  );
  assert.ok(gate >= 0);
  const draft = release.steps.findIndex((step) =>
    step.run?.includes("gh release create"),
  );
  assert.ok(draft >= 0);
  assert.deepEqual(tokenLocations(workflow), [
    `checks.steps.${gate}`,
    `release.steps.${draft}`,
  ]);
  assert.deepEqual(Object.keys(checks.steps[gate].env).sort(), [
    "GITHUB_TOKEN",
    "REQUIRED_WORKFLOWS",
  ]);
  assert.equal(checks.steps[gate].env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(release.steps[draft].env.GH_TOKEN, "${{ github.token }}");
  assert.equal(source.match(/github\.token/g)?.length, 2);
});

// Runs a step's shell script as GitHub runs it on Linux, with stub commands
// that record their arguments and answer from environment variables.
async function runStep(job, stubs, env, name) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile, chmod, rm, readFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workflow } = await workflowFile("publish.yml");
  const steps = workflow.jobs[job].steps;
  const step =
    name === undefined ? steps.at(-1) : steps.find((s) => s.name === name);
  const root = await mkdtemp(join(tmpdir(), "publish-step-"));
  try {
    const bin = join(root, "bin");
    const release = join(root, "release");
    await mkdir(bin);
    await mkdir(release);
    await writeFile(join(release, "package-1.2.3.tgz"), "tarball");
    await writeFile(
      join(release, "SHA256SUMS"),
      "db4b4d0d1cb480bf9aeea253771c00febe627f236765fa37d6a5614f079a3aa0  ./package-1.2.3.tgz\n",
    );
    for (const [name, body] of Object.entries(stubs)) {
      const file = join(bin, name);
      await writeFile(
        file,
        `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`,
      );
      await chmod(file, 0o755);
    }
    const calls = join(root, "calls.log");
    await writeFile(calls, "");
    const result = await new Promise((resolve) => {
      execFile(
        "bash",
        ["-e", "-o", "pipefail", "-c", step.run],
        {
          cwd: release,
          env: {
            ...process.env,
            ...env,
            PATH: `${bin}:${process.env.PATH}`,
            CALLS: calls,
            RUNNER_TEMP: root,
          },
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stdout, stderr }),
      );
    });
    return {
      ...result,
      calls: (await readFile(calls, "utf8")).trim().split("\n"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const linuxOnly = {
  skip:
    process.platform !== "linux" &&
    "the publish steps run only on ubuntu-latest and use GNU tools",
};
const tarballIntegrity =
  "sha512-WBQM9fuLkpBn60cFcU9GUnOBEyhwVxbOpyle0gD/abK/W01QtcFtEsDGj3RZYWrpP2UxasHjQ2plCE6FrzLYdg==";

test(
  "the npm step publishes a new version, skips the same tarball and stops on another",
  linuxOnly,
  async () => {
    const run = (view) =>
      runStep(
        "publish",
        { npm: `if [ "$1" = view ]; then ${view}; fi` },
        {
          NPM_ACCESS: "public",
          NPM_PACKAGE: "@lunchbox-labs/example",
          NPM_VERSION: "1.2.3",
        },
      );
    const missing = await run(`echo "npm error code E404" >&2; exit 1`);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(
      missing.calls.at(-1),
      "npm publish ./package-1.2.3.tgz --ignore-scripts --access public --tag latest",
    );
    const same = await run(`echo "${tarballIntegrity}"; exit 0`);
    assert.equal(same.code, 0, same.stderr);
    assert.ok(!same.calls.some((call) => call.startsWith("npm publish")));
    assert.match(same.stdout, /already on npm with this tarball/);
    const other = await run(`echo "sha512-other"; exit 0`);
    assert.equal(other.code, 1);
    assert.ok(!other.calls.some((call) => call.startsWith("npm publish")));
    assert.match(other.stdout, /different tarball/);
    const offline = await run(`echo "npm error code ECONNRESET" >&2; exit 1`);
    assert.equal(offline.code, 1);
    assert.ok(!offline.calls.some((call) => call.startsWith("npm publish")));
    assert.match(offline.stderr, /ECONNRESET/);
  },
);

test(
  "the draft release step creates a draft, refreshes an existing draft and leaves a published release",
  linuxOnly,
  async () => {
    const run = (releases) =>
      runStep(
        "release",
        {
          gh: `if [ "$1" = api ]; then jq -r "$5" <<'JSON'\n${JSON.stringify(releases)}\nJSON\nfi`,
        },
        {
          GH_REPO: "lunchbox-labs/example",
          RELEASE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
          RELEASE_TAG: "v1.2.3",
        },
      );
    const created = await run([{ tag_name: "v1.2.30", draft: true }]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(
      created.calls.at(-1),
      "gh release create v1.2.3 ./package-1.2.3.tgz --draft --target 0123456789abcdef0123456789abcdef01234567 --generate-notes --title v1.2.3",
    );
    const refreshed = await run([
      { tag_name: "v1.2.4", draft: false },
      { tag_name: "v1.2.3", draft: true },
    ]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.equal(
      refreshed.calls.at(-1),
      "gh release upload v1.2.3 ./package-1.2.3.tgz --clobber",
    );
    const published = await run([{ tag_name: "v1.2.3", draft: false }]);
    assert.equal(published.code, 0, published.stderr);
    assert.ok(
      !published.calls.some((call) =>
        /gh release (?:create|upload)/.test(call),
      ),
    );
    assert.match(published.stdout, /::warning::/);
  },
);

test(
  "a run refuses a version that already has a tag or an npm release",
  linuxOnly,
  async () => {
    const run = (lsRemote, view) =>
      runStep(
        "verify",
        {
          git: `if [ "$1" = ls-remote ]; then ${lsRemote}; fi`,
          npm: `if [ "$1" = view ]; then ${view}; fi`,
        },
        {
          NPM_PACKAGE: "@lunchbox-labs/example",
          NPM_VERSION: "1.2.3",
          RELEASE_TAG: "v1.2.3",
        },
        "Refuse a version that is already released",
      );
    const missingTag = "exit 2";
    const missingVersion = `echo "npm error code E404" >&2; exit 1`;
    const fresh = await run(missingTag, missingVersion);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.deepEqual(fresh.calls, [
      "git ls-remote --exit-code --tags origin refs/tags/v1.2.3",
      "npm view @lunchbox-labs/example@1.2.3 version",
    ]);
    const tagged = await run(
      `echo "abc refs/tags/v1.2.3"; exit 0`,
      missingVersion,
    );
    assert.equal(tagged.code, 1);
    assert.match(tagged.stdout, /::error::Tag v1\.2\.3 already exists/);
    assert.ok(!tagged.calls.some((call) => call.startsWith("npm ")));
    const unreachable = await run("exit 128", missingVersion);
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.stdout, /Could not check whether tag v1\.2\.3/);
    const published = await run(missingTag, `echo "1.2.3"; exit 0`);
    assert.equal(published.code, 1);
    assert.match(
      published.stdout,
      /::error::@lunchbox-labs\/example@1\.2\.3 is already on npm/,
    );
    const offline = await run(
      missingTag,
      `echo "npm error code ECONNRESET" >&2; exit 1`,
    );
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /ECONNRESET/);
  },
);

test("a run started on another branch fails at once", linuxOnly, async () => {
  const run = (ref) =>
    runStep("verify", {}, { RUN_REF: ref }, "Require a run on main");
  const main = await run("refs/heads/main");
  assert.equal(main.code, 0, main.stderr);
  const branch = await run("refs/heads/feature");
  assert.equal(branch.code, 1);
  assert.match(
    branch.stdout,
    /::error::Run Publish on main\. This run was started on refs\/heads\/feature\./,
  );
});

test(
  "the version step names the release in the run summary",
  linuxOnly,
  async () => {
    const { mkdtemp, writeFile, readFile, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { workflow } = await workflowFile("publish.yml");
    const step = workflow.jobs.verify.steps.find(
      (candidate) => candidate.id === "version",
    );
    const run = async (version) => {
      const root = await mkdtemp(join(tmpdir(), "publish-version-"));
      try {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ version }),
        );
        const output = join(root, "output");
        const summary = join(root, "summary");
        await writeFile(output, "");
        await writeFile(summary, "");
        const code = await new Promise((resolve) => {
          execFile(
            "bash",
            ["-e", "-c", step.run],
            {
              cwd: root,
              env: {
                ...process.env,
                GITHUB_OUTPUT: output,
                GITHUB_STEP_SUMMARY: summary,
                RELEASE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
              },
            },
            (error) => resolve(error ? error.code : 0),
          );
        });
        return {
          code,
          output: await readFile(output, "utf8"),
          summary: await readFile(summary, "utf8"),
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    const stable = await run("1.2.3");
    assert.equal(stable.code, 0);
    assert.equal(stable.output, "tag=v1.2.3\n");
    assert.match(stable.summary, /^### Releasing v1\.2\.3$/m);
    assert.match(stable.summary, /0123456789abcdef0123456789abcdef01234567/);
    for (const version of ["1.2.3-beta.1", "1.2", "1.2.3\nname=x"]) {
      const refused = await run(version);
      assert.equal(refused.code, 1, version);
      assert.equal(refused.output, "", version);
      assert.equal(refused.summary, "", version);
    }
  },
);
