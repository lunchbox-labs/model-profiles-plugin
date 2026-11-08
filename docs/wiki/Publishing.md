# Publishing

The [Publish workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/publish.yml) runs only when started by hand on `main`. It releases the version in `package.json`: it publishes `@lunchbox-labs/opencode-model-profiles` to npm and opens a draft GitHub release for `v<version>` with the published package tarball attached. Publishing that draft creates the `v<version>` tag on the release commit. Branch pushes, pull requests and tag pushes do not publish packages.

## Publisher setup

The workflow expects a GitHub `npm` environment that allows deployments from `main`, and an npm trusted publisher for this package. Anyone with write access can start Publish, so the `npm` environment's deployment rules decide who can release. Match the publisher to organization `lunchbox-labs`, repository `opencode-model-profiles`, workflow filename `publish.yml`, and environment `npm`. Allow direct `npm publish`, which is the command this workflow uses. Configure those settings through the respective services; this page describes the required identity, not confirmation of its current setup. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

The publish job has `id-token: write` for OIDC and `contents: read`. It installs a trusted-publishing-capable npm version and enables provenance. The workflow does not use a long-lived npm token. Only the draft release job has `contents: write`, and it runs no repository code. The workflow never creates or pushes a tag itself.

## Prepare and publish a release

1. Keep the version in `package.json` and both root version entries in `package-lock.json` aligned. Use a non-placeholder stable semantic version that has no tag and isn't on npm yet.
2. Complete the required checks and review, and integrate the release commit into `main` through the repository's normal process.
3. When authorized to release, open **Actions**, choose **Publish**, and select **Run workflow** with `main` as the branch. The run releases the commit at the head of `main` when it starts, so start it once the release commit is the latest commit there. Run it once per version. The run's summary names the version being released as soon as the **Release version** job finishes, and links the draft release once the **Draft GitHub release** job has created it.
4. Open the draft release from the run's summary, review it, edit its generated notes if needed, and publish it. Publishing the draft creates the `v<version>` tag on the release commit and does not run the workflow again. Don't push the tag or create the release by hand: Publish refuses a version that is already tagged, tags can't be moved or deleted, and a release created by hand is published at once and can't take the package tarball.

**Release version** stops a run started on any other branch and reads the version from `package.json`. **Verify** then requires the checked-out commit to match the run's commit, and stops before building when `v<version>` is already tagged or the version is already on npm. [validate-release.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/validate-release.mjs) also validates the package identity, repository, registry, access and lockfile metadata.

The verification job runs `npm ci`, `npm run check` and `npm run test:package`. It packs the verified build and uploads a tarball with SHA-256 checksums. The separate publish job downloads that artifact, verifies its checksum and publishes it with scripts disabled and the `latest` tag. It does not rebuild the package. The draft release job then attaches the same tarball to a draft release for `v<version>` that targets the release commit, with generated notes.

If a job fails, inspect it before retrying, and re-run only the failed jobs so the verified package is reused. Re-running the publish job is safe: when npm already holds this version with the same tarball, it skips npm, and it stops if npm holds a different tarball. The draft release job reuses an existing draft for the version and leaves an already published release unchanged. A new run, or a full re-run, stops at verification once the version is on npm, so finish a partly failed release by re-running its failed jobs within the artifact's three days. After that, bump the version, merge it to `main` and run Publish again. Keep release-specific investigation and validation evidence in the tracking issue.

## Release commit checks

After verification, and before publishing, Publish uses [scripts/release-ci.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/release-ci.mjs) to wait up to 40 minutes for the release commit's push run of **Check**. Only the latest run counts, and it must succeed before publication can proceed. Transient GitHub API errors are retried; five consecutive errors fail the gate.

If Check was cancelled, re-run it on the release commit, then re-run the failed Publish jobs.
