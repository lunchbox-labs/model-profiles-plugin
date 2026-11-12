import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateRelease as validate } from "../scripts/validate-release.mjs";

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
const validateRelease = (manifest, tag, options) =>
  validate(manifest, tag, lock, options);

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

test("release validation takes a pre-release version only in a pre-release run", () => {
  const beta = { ...release, version: "1.2.3-beta.1" };
  const betaLock = {
    ...lock,
    version: beta.version,
    packages: { "": { name: beta.name, version: beta.version } },
  };
  assert.equal(
    validate(beta, "v1.2.3-beta.1", betaLock, { prerelease: true }).version,
    "1.2.3-beta.1",
  );
  assert.throws(
    () => validate(beta, "v1.2.3-beta.1", betaLock),
    /stable semantic version/,
  );
  assert.throws(
    () => validateRelease(release, "v1.2.3", { prerelease: true }),
    /pre-release semantic version/,
  );
  for (const version of [
    "1.2.3-",
    "1.2.3-beta..1",
    "1.2.3-beta+1",
    "01.2.3-beta",
  ]) {
    assert.throws(
      () =>
        validateRelease({ ...release, version }, `v${version}`, {
          prerelease: true,
        }),
      version,
    );
  }
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

async function workflowFile(name) {
  const source = await readFile(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );
  return { source, workflow: parseYaml(source) };
}

const repositoryGuard =
  "github.repository == 'lunchbox-labs/opencode-model-profiles' && github.event_name == 'workflow_dispatch'";

test("a manual run on main verifies the package.json version, runs Check, publishes to npm and releases", async () => {
  const { workflow } = await workflowFile("release.yml");
  assert.equal(workflow.name, "Release");
  assert.equal(workflow["run-name"], undefined);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs, {
    dry_run: {
      description:
        "Build and check the release, then stop before npm, the tag and the GitHub release",
      type: "boolean",
      default: false,
    },
    prerelease: {
      description:
        "Publish under npm's next tag and mark the GitHub release as a pre-release",
      type: "boolean",
      default: false,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /github\.event\.|github\.ref_name/,
  );
  assert.deepEqual(workflow.concurrency, {
    group: "release",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "version",
    "verify",
    "check",
    "publish",
    "release",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const {
    version: versionJob,
    verify,
    check,
    publish,
    release,
  } = workflow.jobs;
  assert.equal(versionJob.name, "Release version");
  assert.equal(verify.name, "Verify");
  assert.equal(check.name, "Check");
  assert.equal(publish.name, "Publish npm");
  assert.equal(release.name, "GitHub release");
  assert.equal(versionJob.needs, undefined);
  assert.deepEqual(verify.needs, ["version"]);
  assert.deepEqual(check.needs, ["verify"]);
  assert.deepEqual(publish.needs, ["verify", "check"]);
  assert.deepEqual(release.needs, ["verify", "publish"]);
  for (const job of [versionJob, verify, check]) {
    assert.equal(job.if.replace(/\s+/g, " ").trim(), repositoryGuard);
  }
  // A dry run skips npm, and the release job, which needs the npm job, with it.
  assert.equal(publish.if, "${{ !inputs.dry_run }}");
  assert.equal(release.if, undefined);

  assert.equal(check.uses, "./.github/workflows/check.yml");
  assert.deepEqual(check.permissions, { contents: "read" });
  assert.equal(check.secrets, undefined);

  assert.equal(versionJob.steps[0].name, "Require a run on main");
  assert.deepEqual(versionJob.steps[0].env, { RUN_REF: "${{ github.ref }}" });
  assert.deepEqual(versionJob.outputs, {
    tag: "${{ steps.version.outputs.tag }}",
  });
  const version = versionJob.steps.find((step) => step.id === "version");
  assert.deepEqual(version.env, {
    DRY_RUN: "${{ inputs.dry_run }}",
    PRERELEASE: "${{ inputs.prerelease }}",
    RELEASE_COMMIT: "${{ github.sha }}",
  });
  assert.deepEqual(verify.outputs, {
    access: "${{ steps.release.outputs.access }}",
    name: "${{ steps.release.outputs.name }}",
    tag: "${{ needs.version.outputs.tag }}",
    version: "${{ steps.release.outputs.version }}",
  });
  for (const job of [versionJob, verify]) {
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
  const validateStep = verify.steps.findIndex(
    (step) => step.run === "node scripts/validate-release.mjs",
  );
  const refuse = verify.steps.findIndex(
    (step) => step.name === "Refuse a version that is already released",
  );
  assert.ok(validateStep >= 0 && refuse > validateStep);
  assert.deepEqual(verify.steps[validateStep].env, {
    RELEASE_PRERELEASE: "${{ inputs.prerelease }}",
    RELEASE_TAG: "${{ needs.version.outputs.tag }}",
  });
  let previous = refuse;
  for (const command of ["npm ci", "npm run test:package"]) {
    const index = verify.steps.findIndex((step) => step.run === command);
    assert.ok(index > previous, command);
    previous = index;
  }
  const pack = verify.steps.findIndex((step) =>
    step.run?.includes("npm pack --ignore-scripts --pack-destination release"),
  );
  assert.ok(pack > previous);
  assert.match(verify.steps[pack].run, /sha256sum/);
  const upload = verify.steps.findIndex((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload > pack);
  assert.equal(verify.steps[upload].with.path, "release/");
  for (const job of [publish, release]) {
    const download = job.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    assert.equal(download.with.name, verify.steps[upload].with.name);
    assert.equal(download.with.path, "release");
  }

  const npm = publish.steps.find((step) => step.run?.includes("npm publish"));
  assert.equal(npm["working-directory"], "release");
  assert.deepEqual(npm.env, {
    NPM_ACCESS: "${{ needs.verify.outputs.access }}",
    NPM_PACKAGE: "${{ needs.verify.outputs.name }}",
    NPM_TAG: "${{ inputs.prerelease && 'next' || 'latest' }}",
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
    /npm publish \.\/\*\.tgz --ignore-scripts --access "\$NPM_ACCESS" --tag "\$NPM_TAG"/,
  );

  const create = release.steps.find(
    (step) => step.name === "Create the tag and the GitHub release",
  );
  assert.equal(create.id, "release");
  assert.equal(create["working-directory"], "release");
  assert.deepEqual(create.env, {
    GH_TOKEN: "${{ github.token }}",
    GH_REPO: "${{ github.repository }}",
    PRERELEASE: "${{ inputs.prerelease }}",
    RELEASE_COMMIT: "${{ github.sha }}",
    RELEASE_TAG: "${{ needs.verify.outputs.tag }}",
  });
  assert.ok(
    create.run.indexOf("sha256sum --check SHA256SUMS") <
      create.run.indexOf("gh release create"),
  );
  assert.doesNotMatch(
    create.run,
    /--draft(?!=false)|gh release delete|git (tag|push)/,
  );
  const summary = release.steps.find(
    (step) => step.name === "Link the release in the run summary",
  );
  assert.ok(release.steps.indexOf(summary) > release.steps.indexOf(create));
  assert.equal(summary.if, "steps.release.outputs.url != ''");
  assert.equal(summary["continue-on-error"], true);
  assert.deepEqual(summary.env, {
    RELEASE_ATTACHED: "${{ steps.release.outputs.attached }}",
    RELEASE_TAG: "${{ needs.verify.outputs.tag }}",
    RELEASE_URL: "${{ steps.release.outputs.url }}",
  });
  assert.doesNotMatch(summary.run, /\bgh\b|git /);
  assert.ok(
    !release.steps.some((step) => step.uses?.startsWith("actions/checkout@")),
    "the job that can write to the repository runs no repository code",
  );
});

test("Release grants OIDC only to npm publication and repository writes only to the GitHub release job", async () => {
  const { source, workflow } = await workflowFile("release.yml");
  assert.doesNotMatch(source, /secrets\.|vars\./);
  const allowed = new Set([
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  ]);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      job.environment,
      ["publish", "release"].includes(jobName) ? "release" : undefined,
      jobName,
    );
    assert.equal(
      job.permissions?.contents ?? workflow.permissions.contents,
      jobName === "release" ? "write" : "read",
      jobName,
    );
    assert.equal(
      job.permissions?.["id-token"],
      jobName === "publish" ? "write" : undefined,
      jobName,
    );
    assert.deepEqual(
      Object.keys(job.permissions ?? {}).filter(
        (scope) => !["contents", "id-token"].includes(scope),
      ),
      [],
      jobName,
    );
    assert.doesNotMatch(
      JSON.stringify(job.outputs ?? {}),
      /token|secrets\.|vars\./,
    );
    for (const step of job.steps ?? []) {
      if (step.uses) {
        assert.ok(allowed.has(step.uses), step.uses);
      }
    }
  }
});

test("Check runs on pushes to main and as Release's called workflow in a group of its own", async () => {
  const { workflow } = await workflowFile("check.yml");
  assert.equal(workflow.name, "Check");
  assert.ok(workflow.on.push.branches.includes("main"));
  for (const filter of ["branches-ignore", "paths", "paths-ignore"]) {
    assert.equal(workflow.on.push[filter], undefined, filter);
  }
  assert.equal(workflow.on.workflow_call, null);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  // A called workflow sees the caller's github context, so the group starts with
  // Release, not Check, and a push to main can't cancel or replace Release's checks.
  assert.equal(
    workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
  );
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
  const { source } = await workflowFile("check.yml");
  assert.doesNotMatch(source, /secrets\.|github\.token|contents: write/);
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

test("only the GitHub release step receives the GitHub token", async () => {
  const { source, workflow } = await workflowFile("release.yml");
  const create = workflow.jobs.release.steps.findIndex(
    (step) => step.name === "Create the tag and the GitHub release",
  );
  assert.ok(create >= 0);
  assert.deepEqual(tokenLocations(workflow), [`release.steps.${create}`]);
  assert.equal(source.match(/github\.token/g)?.length, 1);
});

// Runs a step's shell script as GitHub runs it on Linux, with stub commands
// that record their arguments and answer from environment variables.
async function runStep(job, stubs, env, name) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile, chmod, rm, readFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workflow } = await workflowFile("release.yml");
  const steps = workflow.jobs[job].steps;
  const step =
    name === undefined ? steps.at(-1) : steps.find((s) => s.name === name);
  const root = await mkdtemp(join(tmpdir(), "release-step-"));
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
    const output = join(root, "output");
    const summary = join(root, "summary.md");
    await writeFile(calls, "");
    await writeFile(output, "");
    await writeFile(summary, "");
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
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
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
      output: await readFile(output, "utf8"),
      summary: await readFile(summary, "utf8"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const linuxOnly = {
  skip:
    process.platform !== "linux" &&
    "the release steps run only on ubuntu-latest and use GNU tools",
};
const tarballIntegrity =
  "sha512-WBQM9fuLkpBn60cFcU9GUnOBEyhwVxbOpyle0gD/abK/W01QtcFtEsDGj3RZYWrpP2UxasHjQ2plCE6FrzLYdg==";

test(
  "the npm step publishes a new version under its tag, skips the same tarball and stops on another",
  linuxOnly,
  async () => {
    const run = (view, tag = "latest") =>
      runStep(
        "publish",
        { npm: `if [ "$1" = view ]; then ${view}; fi` },
        {
          NPM_ACCESS: "public",
          NPM_PACKAGE: "@lunchbox-labs/example",
          NPM_TAG: tag,
          NPM_VERSION: "1.2.3",
        },
      );
    const missingVersion = `echo "npm error code E404" >&2; exit 1`;
    const missing = await run(missingVersion);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(
      missing.calls.at(-1),
      "npm publish ./package-1.2.3.tgz --ignore-scripts --access public --tag latest",
    );
    const next = await run(missingVersion, "next");
    assert.equal(next.code, 0, next.stderr);
    assert.equal(
      next.calls.at(-1),
      "npm publish ./package-1.2.3.tgz --ignore-scripts --access public --tag next",
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

const commit = "0123456789abcdef0123456789abcdef01234567";
const releasePage =
  "https://github.com/lunchbox-labs/example/releases/tag/v1.2.3";

// Runs the release step against a stub gh. tag is the commit the tag points
// at, or undefined when the tag is missing; releases is the releases API list.
const runRelease = ({ tag, tagError, releases = [], prerelease = false }) =>
  runStep(
    "release",
    {
      gh: [
        `if [ "$1 $2" = "api repos/lunchbox-labs/example/git/ref/tags/v1.2.3" ]; then`,
        tagError
          ? `  echo "${tagError}" >&2; exit 1`
          : tag === undefined
            ? `  echo "gh: Not Found (HTTP 404)" >&2; exit 1`
            : `  echo "${tag}"; exit 0`,
        `fi`,
        `if [ "$1" = api ]; then jq -r "$5" <<'JSON'\n${JSON.stringify(releases)}\nJSON\nexit 0; fi`,
        `if [ "$1 $2" = "release view" ]; then echo "${releasePage}"; fi`,
      ].join("\n"),
    },
    {
      GH_REPO: "lunchbox-labs/example",
      PRERELEASE: String(prerelease),
      RELEASE_COMMIT: commit,
      RELEASE_TAG: "v1.2.3",
    },
    "Create the tag and the GitHub release",
  );

test(
  "the release step creates the tag and a published release with the package",
  linuxOnly,
  async () => {
    const created = await runRelease({
      releases: [
        { tag_name: "v1.2.30", draft: false, html_url: "x", assets: [] },
      ],
    });
    assert.equal(created.code, 0, created.stderr);
    assert.ok(
      created.calls.includes(
        `gh release create v1.2.3 ./package-1.2.3.tgz --target ${commit} --generate-notes --title v1.2.3`,
      ),
      created.calls.join("\n"),
    );
    assert.equal(created.output, `attached=true\nurl=${releasePage}\n`);
    const pre = await runRelease({ prerelease: true });
    assert.equal(pre.code, 0, pre.stderr);
    assert.ok(
      pre.calls.includes(
        `gh release create v1.2.3 ./package-1.2.3.tgz --target ${commit} --generate-notes --title v1.2.3 --prerelease`,
      ),
      pre.calls.join("\n"),
    );
  },
);

test(
  "a re-run accepts the tag on the release commit, publishes a draft and leaves a published release",
  linuxOnly,
  async () => {
    const tagged = await runRelease({ tag: commit });
    assert.equal(tagged.code, 0, tagged.stderr);
    assert.ok(
      tagged.calls.some((call) => call.startsWith("gh release create")),
    );

    const draft = await runRelease({
      releases: [
        { tag_name: "v1.2.3", draft: true, html_url: "draft", assets: [] },
      ],
    });
    assert.equal(draft.code, 0, draft.stderr);
    assert.ok(
      !draft.calls.some((call) => call.startsWith("gh release create")),
    );
    const upload = draft.calls.indexOf(
      "gh release upload v1.2.3 ./package-1.2.3.tgz --clobber",
    );
    const edit = draft.calls.indexOf(
      `gh release edit v1.2.3 --draft=false --target ${commit} --title v1.2.3`,
    );
    assert.ok(upload >= 0 && edit > upload, draft.calls.join("\n"));
    assert.equal(draft.output, `attached=true\nurl=${releasePage}\n`);

    const published = await runRelease({
      tag: commit,
      releases: [
        {
          tag_name: "v1.2.3",
          draft: false,
          html_url: releasePage,
          assets: [{ name: "package-1.2.3.tgz" }],
        },
      ],
    });
    assert.equal(published.code, 0, published.stderr);
    assert.ok(
      !published.calls.some((call) =>
        /gh release (?:create|upload|edit)/.test(call),
      ),
    );
    assert.equal(published.output, `attached=true\nurl=${releasePage}\n`);

    const bare = await runRelease({
      tag: commit,
      releases: [
        { tag_name: "v1.2.3", draft: false, html_url: releasePage, assets: [] },
      ],
    });
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /::warning::.*without package-1\.2\.3\.tgz/);
    assert.equal(bare.output, `attached=false\nurl=${releasePage}\n`);
  },
);

test(
  "the release step stops when the tag points elsewhere or can't be read",
  linuxOnly,
  async () => {
    const moved = await runRelease({
      tag: "fedcba9876543210fedcba9876543210fedcba98",
    });
    assert.equal(moved.code, 1);
    assert.match(moved.stdout, /::error::Tag v1\.2\.3 points at fedcba98/);
    assert.ok(!moved.calls.some((call) => call.startsWith("gh release")));
    const unreachable = await runRelease({
      tagError: "gh: Bad credentials (HTTP 401)",
    });
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.stderr, /HTTP 401/);
    assert.ok(!unreachable.calls.some((call) => call.startsWith("gh release")));
  },
);

test("the run summary links the release", linuxOnly, async () => {
  const run = (attached) =>
    runStep(
      "release",
      {},
      {
        RELEASE_ATTACHED: attached,
        RELEASE_TAG: "v1.2.3",
        RELEASE_URL: releasePage,
      },
      "Link the release in the run summary",
    );
  const attached = await run("true");
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.summary, /^### Released v1\.2\.3$/m);
  assert.ok(
    attached.summary.includes(
      `[The v1.2.3 release](${releasePage}) is published`,
    ),
  );
  const bare = await run("false");
  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.summary, /without the package/);
});

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
    runStep("version", {}, { RUN_REF: ref }, "Require a run on main");
  const main = await run("refs/heads/main");
  assert.equal(main.code, 0, main.stderr);
  const branch = await run("refs/heads/feature");
  assert.equal(branch.code, 1);
  assert.match(
    branch.stdout,
    /::error::Run Release on main\. This run was started on refs\/heads\/feature\./,
  );
});

test(
  "the Release version job names the release in the run summary",
  linuxOnly,
  async () => {
    const { mkdtemp, writeFile, readFile, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { workflow } = await workflowFile("release.yml");
    const step = workflow.jobs.version.steps.find(
      (candidate) => candidate.id === "version",
    );
    const run = async (
      version,
      { dryRun = false, prerelease = false } = {},
    ) => {
      const root = await mkdtemp(join(tmpdir(), "release-version-"));
      try {
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ version }),
        );
        const output = join(root, "output");
        const summary = join(root, "summary");
        await writeFile(output, "");
        await writeFile(summary, "");
        const { code, stdout } = await new Promise((resolve) => {
          execFile(
            "bash",
            ["-e", "-c", step.run],
            {
              cwd: root,
              env: {
                ...process.env,
                DRY_RUN: String(dryRun),
                GITHUB_OUTPUT: output,
                GITHUB_STEP_SUMMARY: summary,
                PRERELEASE: String(prerelease),
                RELEASE_COMMIT: commit,
              },
            },
            (error, stdout) =>
              resolve({ code: error ? error.code : 0, stdout }),
          );
        });
        return {
          code,
          stdout,
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
    assert.match(
      stable.stdout,
      /::notice::Releasing v1\.2\.3 from 0123456789abcdef/,
    );
    assert.match(stable.summary, /^### Release v1\.2\.3$/m);
    assert.match(stable.summary, new RegExp(commit));
    assert.match(stable.summary, /as a release\./);
    assert.doesNotMatch(stable.summary, /Dry run/);
    const dry = await run("1.2.3", { dryRun: true });
    assert.equal(dry.code, 0);
    assert.match(dry.summary, /^Dry run: /m);
    const beta = await run("1.2.3-beta.1", { prerelease: true });
    assert.equal(beta.code, 0);
    assert.equal(beta.output, "tag=v1.2.3-beta.1\n");
    assert.match(beta.summary, /as a pre-release\./);
    for (const [version, prerelease] of [
      ["1.2.3-beta.1", false],
      ["1.2.3", true],
      ["1.2", false],
      ["1.2.3\nname=x", false],
      ["1.2.3-beta\nname=x", true],
    ]) {
      const refused = await run(version, { prerelease });
      assert.equal(refused.code, 1, version);
      assert.equal(refused.output, "", version);
      assert.equal(refused.summary, "", version);
    }
  },
);
