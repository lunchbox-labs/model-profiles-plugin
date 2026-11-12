import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  corePackage,
  releasePackages,
  validateRelease as validate,
  workspacePackages,
} from "../scripts/validate-release.mjs";

const coreName = "@lunchbox-labs/model-profiles-core";
/** The published packages, in release order. */
const names = [
  "@lunchbox-labs/opencode-model-profiles",
  "@lunchbox-labs/kilo-model-profiles",
];
/** Every workspace package, the private core first, as validateRelease takes their manifests. */
const workspaceNames = [coreName, ...names];
const directories = ["packages/core", "packages/opencode", "packages/kilo"];

/** One manifest per workspace package: the private core, then the host packages that bundle it. */
const manifestsAt = (version, change = () => ({})) =>
  workspaceNames.map((name, index) => ({
    name,
    version,
    ...(index === 0
      ? { private: true }
      : {
          repository: {
            url: "git+https://github.com/lunchbox-labs/opencode-model-profiles.git",
          },
          publishConfig: { access: "public" },
          dependencies: { "jsonc-parser": "^3.3.1" },
          devDependencies: { "@opencode-ai/plugin": "1.19.5" },
        }),
    ...change(index),
  }));
const lockAt = (version, manifests = manifestsAt(version)) => ({
  name: "model-profiles-workspace",
  packages: {
    "": { name: "model-profiles-workspace" },
    ...Object.fromEntries(
      manifests.map((manifest, index) => [
        directories[index],
        {
          name: manifest.name,
          version: manifest.version,
          ...Object.fromEntries(
            [
              "dependencies",
              "devDependencies",
              "peerDependencies",
              "optionalDependencies",
            ]
              .filter((field) => manifest[field] !== undefined)
              .map((field) => [field, manifest[field]]),
          ),
        },
      ]),
    ),
  },
});
const release = manifestsAt("1.2.3");
const lock = lockAt("1.2.3");
const validateRelease = (manifests, tag, options) =>
  validate(manifests, tag, lock, options);

/** The release manifests with one workspace package's manifest changed. */
const changed = (index, change) =>
  release.map((manifest, other) =>
    other === index ? { ...manifest, ...change } : manifest,
  );

test("release validation takes the private core, then the OpenCode and Kilo packages in publication order", () => {
  assert.deepEqual(corePackage, {
    directory: "packages/core",
    name: coreName,
  });
  assert.deepEqual(releasePackages, [
    { directory: "packages/opencode", name: names[0] },
    { directory: "packages/kilo", name: names[1] },
  ]);
  assert.deepEqual(workspacePackages, [corePackage, ...releasePackages]);
  for (const manifests of [
    undefined,
    release.slice(1),
    release.slice(0, 2),
    [release[0], release[2], release[1]],
    [release[1], release[0], release[2]],
  ]) {
    assert.throws(() => validateRelease(manifests, "v1.2.3"));
  }
});

test("release validation rejects stale or missing lockfile versions", () => {
  for (const broken of [
    undefined,
    { packages: {} },
    lockAt("1.2.2"),
    lockAt("1.2.3", changed(0, { version: "1.2.2" })),
    lockAt("1.2.3", changed(2, { version: "1.2.2" })),
  ]) {
    assert.throws(() => validate(release, "v1.2.3", broken), /lockfile/);
  }
});

test("release validation requires one version, a private core at it and host packages that never name the core", () => {
  assert.throws(
    () => validateRelease(changed(1, { version: "1.2.4" }), "v1.2.3"),
    /release tag/,
  );
  for (const change of [
    { private: undefined },
    { private: false },
    { private: "true" },
  ]) {
    assert.throws(
      () => validateRelease(changed(0, change), "v1.2.3"),
      /never published/,
      JSON.stringify(change),
    );
  }
  assert.throws(
    () => validateRelease(changed(0, { name: names[0] }), "v1.2.3"),
    /packages\/core must be @lunchbox-labs\/model-profiles-core/,
  );
  const staleCore = changed(0, { version: "1.2.2" });
  assert.throws(
    () => validate(staleCore, "v1.2.3", lockAt("1.2.3", staleCore)),
    /model-profiles-core must have the release version 1\.2\.3/,
  );
  for (const index of [1, 2]) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const manifests = changed(index, {
        [field]: { ...release[index][field], [coreName]: "1.2.3" },
      });
      assert.throws(
        () => validate(manifests, "v1.2.3", lockAt("1.2.3", manifests)),
        new RegExp(
          `bundles @lunchbox-labs/model-profiles-core; remove it from ${field}`,
        ),
      );
      const stale = lockAt("1.2.3");
      stale.packages[directories[index]][field] = { [coreName]: "1.2.3" };
      assert.throws(() => validate(release, "v1.2.3", stale), /bundles/);
    }
  }
});

test("release validation accepts explicit public and scoped restricted stable releases", () => {
  assert.deepEqual(validateRelease(release, "v1.2.3"), {
    names,
    version: "1.2.3",
    access: "public",
  });
  assert.equal(
    validateRelease(
      manifestsAt("1.2.3", (index) =>
        index === 0 ? {} : { publishConfig: { access: "restricted" } },
      ),
      "v1.2.3",
    ).access,
    "restricted",
  );
  assert.throws(
    () =>
      validateRelease(
        changed(2, { publishConfig: { access: "restricted" } }),
        "v1.2.3",
      ),
    /same publishConfig\.access/,
  );
});

test("release validation takes a pre-release version only in a pre-release run", () => {
  const beta = manifestsAt("1.2.3-beta.1");
  const betaLock = lockAt("1.2.3-beta.1");
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
        validate(manifestsAt(version), `v${version}`, lockAt(version), {
          prerelease: true,
        }),
      version,
    );
  }
});

test("release validation rejects private, provisional, mismatched, prerelease, and misrouted packages", () => {
  for (const index of [1, 2]) {
    const name = workspaceNames[index];
    for (const change of [
      { private: true },
      { private: "false" },
      { name: "package-name-tbd" },
      { name: "invalid name" },
      { name: name.replace("@lunchbox-labs/", "") },
      { name: name.replace("@lunchbox-labs/", "@other/") },
      { name: workspaceNames[index === 1 ? 2 : 1] },
      { name: coreName },
      { version: "0.0.0" },
      { version: "1.2.3-beta.1" },
      { version: "01.2.3" },
      { publishConfig: undefined },
      { publishConfig: { access: "other" } },
      { name: "unscoped", publishConfig: { access: "restricted" } },
      {
        publishConfig: {
          access: "public",
          registry: "https://example.invalid",
        },
      },
      { repository: { url: "git+https://github.com/example/other.git" } },
      {
        repository: {
          url: "git+https://github.com/lunchbox-labs/kilo-model-profiles.git",
        },
      },
    ]) {
      assert.throws(
        () => validateRelease(changed(index, change), "v1.2.3"),
        undefined,
        `${name}: ${JSON.stringify(change)}`,
      );
    }
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

test("a manual run on main verifies the packages' version, runs Check, publishes to npm and releases", async () => {
  const { workflow } = await workflowFile("release.yml");
  assert.equal(workflow.name, "Release");
  assert.equal(workflow["run-name"], undefined);
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), ["dry_run", "prerelease"]);
  for (const input of Object.values(inputs)) {
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
  }
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
    names: "${{ steps.release.outputs.names }}",
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
  const exists = verify.steps.findIndex(
    (step) => step.name === "Require every package to exist on npm",
  );
  assert.ok(exists > refuse);
  assert.deepEqual(verify.steps[exists].env, {
    NPM_PACKAGES: "${{ steps.release.outputs.names }}",
  });
  let previous = exists;
  for (const command of ["npm ci", "npm run test:package"]) {
    const index = verify.steps.findIndex((step) => step.run === command);
    assert.ok(index > previous, command);
    previous = index;
  }
  const pack = verify.steps.findIndex((step) =>
    step.run?.includes(
      "npm pack --workspace packages/opencode --workspace packages/kilo --ignore-scripts --pack-destination release",
    ),
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
    NPM_PACKAGES: "${{ needs.verify.outputs.names }}",
    NPM_TAG: "${{ inputs.prerelease && 'next' || 'latest' }}",
    NPM_VERSION: "${{ needs.verify.outputs.version }}",
    NPM_CONFIG_PROVENANCE: "true",
  });
  const order = [
    "sha256sum --check SHA256SUMS",
    'npm view "$package@$NPM_VERSION" dist.integrity',
    "npm publish",
  ].map((text) => npm.run.indexOf(text));
  assert.ok(
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
  );
  assert.match(
    npm.run,
    /npm publish "\$file" --ignore-scripts --access "\$NPM_ACCESS" --tag "\$NPM_TAG"/,
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

// npm names a scoped package's tarball scope-name-version.tgz; these are the
// two a 1.2.3 release packs, in release order.
const tarballFiles = names.map(
  (name) => `${name.slice(1).replace("/", "-")}-1.2.3.tgz`,
);
const tarballContent = (file) => `tarball ${file}`;
const integrity = (file) =>
  `sha512-${createHash("sha512").update(tarballContent(file)).digest("base64")}`;
// The step lists the release directory's tarballs alphabetically.
const listed = [...tarballFiles].sort().map((file) => `./${file}`);

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
    for (const file of tarballFiles) {
      await writeFile(join(release, file), tarballContent(file));
    }
    await writeFile(
      join(release, "SHA256SUMS"),
      tarballFiles
        .map(
          (file) =>
            `${createHash("sha256").update(tarballContent(file)).digest("hex")}  ./${file}\n`,
        )
        .join(""),
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
const missingVersion = `echo "npm error code E404" >&2; exit 1`;

// An npm stub whose `npm view <name>@<version>` runs the command given for
// that package, and reports the version missing for the others. A bare
// `npm view <name>` runs the command packageAnswers gives for that package,
// and otherwise reports the package as published.
const npmView = (answers, packageAnswers = {}) =>
  [
    `if [ "$1" = view ]; then`,
    `  case "$2" in`,
    ...Object.entries(answers).map(
      ([name, answer]) => `    "${name}@1.2.3") ${answer} ;;`,
    ),
    ...Object.entries(packageAnswers).map(
      ([name, answer]) => `    "${name}") ${answer} ;;`,
    ),
    `    @*/*@*) ${missingVersion} ;;`,
    `    *) echo "$2" ;;`,
    `  esac`,
    `fi`,
  ].join("\n");

test(
  "the npm step publishes the OpenCode and Kilo packages in order under the tag, skips each tarball npm holds and stops on another",
  linuxOnly,
  async () => {
    const run = (answers, tag = "latest") =>
      runStep(
        "publish",
        { npm: npmView(answers) },
        {
          NPM_ACCESS: "public",
          NPM_PACKAGES: names.join(" "),
          NPM_TAG: tag,
          NPM_VERSION: "1.2.3",
        },
      );
    const published = (result) =>
      result.calls.filter((call) => call.startsWith("npm publish"));
    const publish = (file, tag = "latest") =>
      `npm publish ./${file} --ignore-scripts --access public --tag ${tag}`;
    const missing = await run({});
    assert.equal(missing.code, 0, missing.stderr);
    assert.deepEqual(
      published(missing),
      tarballFiles.map((file) => publish(file)),
    );
    const next = await run({}, "next");
    assert.equal(next.code, 0, next.stderr);
    assert.deepEqual(
      published(next),
      tarballFiles.map((file) => publish(file, "next")),
    );
    const same = (index) => `echo "${integrity(tarballFiles[index])}"; exit 0`;
    const partial = await run({ [names[0]]: same(0) });
    assert.equal(partial.code, 0, partial.stderr);
    assert.deepEqual(
      published(partial),
      tarballFiles.slice(1).map((file) => publish(file)),
    );
    assert.match(
      partial.stdout,
      /@lunchbox-labs\/opencode-model-profiles@1\.2\.3 is already on npm with this tarball/,
    );
    const all = await run(
      Object.fromEntries(names.map((name, index) => [name, same(index)])),
    );
    assert.equal(all.code, 0, all.stderr);
    assert.deepEqual(published(all), []);
    const other = await run({ [names[1]]: `echo "sha512-other"; exit 0` });
    assert.equal(other.code, 1);
    assert.deepEqual(published(other), [publish(tarballFiles[0])]);
    assert.match(
      other.stdout,
      /kilo-model-profiles@1\.2\.3 is already on npm with a different tarball/,
    );
    const offline = await run({
      [names[0]]: `echo "npm error code ECONNRESET" >&2; exit 1`,
    });
    assert.equal(offline.code, 1);
    assert.deepEqual(published(offline), []);
    assert.match(offline.stderr, /ECONNRESET/);
  },
);

const commit = "0123456789abcdef0123456789abcdef01234567";
const releasePage =
  "https://github.com/lunchbox-labs/example/releases/tag/v1.2.3";

// Runs the release step against a stub gh. tag is the commit the tag points
// at, or undefined when the tag is missing; releases is the releases API list.
// releasesError and createError make those gh calls fail.
const runRelease = ({
  tag,
  tagError,
  releases = [],
  releasesError,
  createError,
  prerelease = false,
}) =>
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
        `if [ "$1" = api ]; then`,
        releasesError ? `  echo "${releasesError}" >&2; exit 1` : `  :`,
        // The filter is the argument after --jq.
        `  while [ "$#" -gt 0 ] && [ "$1" != --jq ]; do shift; done`,
        `  jq -r "$2" <<'JSON'\n${JSON.stringify(releases)}\nJSON\n  exit 0`,
        `fi`,
        createError
          ? `if [ "$1 $2" = "release create" ]; then echo "${createError}" >&2; exit 1; fi`
          : ``,
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
  "the release step creates the tag and a published release with every package",
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
        `gh release create v1.2.3 ${listed.join(" ")} --target ${commit} --generate-notes --title v1.2.3 --prerelease=false`,
      ),
      created.calls.join("\n"),
    );
    assert.equal(created.output, `attached=true\nurl=${releasePage}\n`);
    const pre = await runRelease({ prerelease: true });
    assert.equal(pre.code, 0, pre.stderr);
    assert.ok(
      pre.calls.includes(
        `gh release create v1.2.3 ${listed.join(" ")} --target ${commit} --generate-notes --title v1.2.3 --prerelease=true`,
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
      `gh release upload v1.2.3 ${listed.join(" ")} --clobber`,
    );
    const edit = draft.calls.indexOf(
      `gh release edit v1.2.3 --draft=false --target ${commit} --title v1.2.3 --prerelease=false`,
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
          assets: tarballFiles.map((name) => ({ name })),
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
        {
          tag_name: "v1.2.3",
          draft: false,
          html_url: releasePage,
          assets: [{ name: tarballFiles[0] }],
        },
      ],
    });
    assert.equal(bare.code, 0, bare.stderr);
    assert.ok(
      bare.stdout.includes(
        `::warning::The v1.2.3 release is already published without ${[...tarballFiles].slice(1).sort().join(" ")}, so the packages could not be attached.`,
      ),
      bare.stdout,
    );
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

test(
  "a pre-release re-run publishes a draft as a pre-release",
  linuxOnly,
  async () => {
    const draft = await runRelease({
      prerelease: true,
      releases: [
        { tag_name: "v1.2.3", draft: true, html_url: "draft", assets: [] },
      ],
    });
    assert.equal(draft.code, 0, draft.stderr);
    assert.ok(
      draft.calls.includes(
        `gh release edit v1.2.3 --draft=false --target ${commit} --title v1.2.3 --prerelease=true`,
      ),
      draft.calls.join("\n"),
    );
  },
);

test(
  "the release step fails without a release link when GitHub refuses the release or the listing",
  linuxOnly,
  async () => {
    const refused = await runRelease({
      createError: "HTTP 422: Repository rule violations found",
    });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /HTTP 422/);
    assert.equal(refused.output, "");
    const unlisted = await runRelease({
      releasesError: "gh: Server Error (HTTP 502)",
    });
    assert.equal(unlisted.code, 1);
    assert.ok(
      !unlisted.calls.some((call) => call.startsWith("gh release")),
      unlisted.calls.join("\n"),
    );
    assert.equal(unlisted.output, "");
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
  assert.match(bare.summary, /without every package/);
});

test(
  "a run refuses a version that already has a tag or an npm release of any package",
  linuxOnly,
  async () => {
    const run = (lsRemote, answers = {}) =>
      runStep(
        "verify",
        {
          git: `if [ "$1" = ls-remote ]; then ${lsRemote}; fi`,
          npm: npmView(answers),
        },
        {
          NPM_PACKAGES: names.join(" "),
          NPM_VERSION: "1.2.3",
          RELEASE_TAG: "v1.2.3",
        },
        "Refuse a version that is already released",
      );
    const missingTag = "exit 2";
    const fresh = await run(missingTag);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.deepEqual(fresh.calls, [
      "git ls-remote --exit-code --tags origin refs/tags/v1.2.3",
      ...names.map((name) => `npm view ${name}@1.2.3 version`),
    ]);
    const tagged = await run(`echo "abc refs/tags/v1.2.3"; exit 0`);
    assert.equal(tagged.code, 1);
    assert.match(tagged.stdout, /::error::Tag v1\.2\.3 already exists/);
    assert.ok(!tagged.calls.some((call) => call.startsWith("npm ")));
    const unreachable = await run("exit 128");
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.stdout, /Could not check whether tag v1\.2\.3/);
    for (const name of names) {
      const published = await run(missingTag, {
        [name]: `echo "1.2.3"; exit 0`,
      });
      assert.equal(published.code, 1, name);
      assert.ok(
        published.stdout.includes(`::error::${name}@1.2.3 is already on npm`),
        published.stdout,
      );
    }
    const offline = await run(missingTag, {
      [names[1]]: `echo "npm error code ECONNRESET" >&2; exit 1`,
    });
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /ECONNRESET/);
  },
);

test(
  "a run stops before building when any package was never published to npm",
  linuxOnly,
  async () => {
    const run = (answers = {}) =>
      runStep(
        "verify",
        { npm: npmView({}, answers) },
        { NPM_PACKAGES: names.join(" ") },
        "Require every package to exist on npm",
      );
    const published = await run();
    assert.equal(published.code, 0, published.stderr);
    assert.deepEqual(
      published.calls,
      names.map((name) => `npm view ${name} name`),
    );
    const neverPublished = {
      [names[0]]: missingVersion,
      [names[1]]: missingVersion,
    };
    const missing = await run(neverPublished);
    assert.equal(missing.code, 1);
    assert.ok(
      missing.stdout.includes(
        `::error::Not on npm yet: ${names[0]} ${names[1]}.`,
      ),
      missing.stdout,
    );
    // Every package is checked, so one run names all that need bootstrapping.
    assert.equal(missing.calls.length, names.length);
    const kiloOnly = await run({ [names[1]]: missingVersion });
    assert.equal(kiloOnly.code, 1);
    assert.ok(
      kiloOnly.stdout.includes(`::error::Not on npm yet: ${names[1]}.`),
      kiloOnly.stdout,
    );
    const offline = await run({
      [names[1]]: `echo "npm error code ECONNRESET" >&2; exit 1`,
    });
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
    const { mkdtemp, mkdir, writeFile, readFile, rm } =
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
      {
        dryRun = false,
        prerelease = false,
        kilo = version,
        core = version,
      } = {},
    ) => {
      const root = await mkdtemp(join(tmpdir(), "release-version-"));
      try {
        // The private workspace root has no version of its own.
        await writeFile(join(root, "package.json"), JSON.stringify({}));
        for (const directory of directories) {
          await mkdir(join(root, directory), { recursive: true });
          await writeFile(
            join(root, directory, "package.json"),
            JSON.stringify({
              version:
                directory === "packages/kilo"
                  ? kilo
                  : directory === "packages/core"
                    ? core
                    : version,
            }),
          );
        }
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
    // The private core's version is Verify's to check, with the manifests.
    const core = await run("1.2.3", { core: "1.2.4" });
    assert.equal(core.code, 0);
    assert.equal(core.output, "tag=v1.2.3\n");
    const mismatched = await run("1.2.3", { kilo: "1.2.4" });
    assert.equal(mismatched.code, 1);
    assert.match(mismatched.stdout, /must have the same version/);
    assert.equal(mismatched.output, "");
    assert.equal(mismatched.summary, "");
  },
);
