# Publishing

The [Release workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/release.yml) runs only when started by hand on `main`. It releases the version in `package.json` in one run: it publishes `@lunchbox-labs/opencode-model-profiles` to npm, creates the `v<version>` tag on the release commit, and publishes a GitHub release for that tag with the package tarball attached and notes generated from the merged pull requests. Branch pushes, pull requests and tag pushes do not publish packages.

## Publisher setup

The workflow expects these settings, configured through the respective services. This page describes the required setup, not confirmation of its current state.

- **npm trusted publisher:** organization `lunchbox-labs`, repository `opencode-model-profiles`, workflow filename `release.yml`, environment `release`. Allow direct `npm publish`, which is the command this workflow uses. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
- **`release` environment:** allows deployments from `main` only. It holds no secrets or variables.
- **Actions policy:** only maintainers may start Release, and Wiki may run only on pushes to `main`. Both can write to the repository.
- **Tag rulesets:** a ruleset blocks updating and deleting `v*` tags. No ruleset blocks creating them, because Release creates the tag itself.

The publish job has `id-token: write` for OIDC and `contents: read`. It installs a trusted-publishing-capable npm version and enables provenance. The workflow does not use a long-lived npm token. Only the GitHub release job has `contents: write`, and it runs no repository code. Both jobs run in the `release` environment.

## Prepare and run a release

1. Keep the version in `package.json` and both root version entries in `package-lock.json` aligned. Use a non-placeholder semantic version that has no tag and isn't on npm yet: a stable version such as `1.2.3` for a release, or a pre-release version such as `1.2.3-beta.1` for a pre-release.
2. Complete the required checks and review, and integrate the release commit into `main` through the repository's normal process.
3. Open **Actions**, choose **Release**, and select **Run workflow** with `main` as the branch. The run releases the commit at the head of `main` when it starts, so start it once the release commit is the latest commit there. Run it once per version.

The run has two inputs:

- **dry_run:** builds and checks the release, then stops before npm, the tag and the GitHub release.
- **prerelease:** publishes under npm's `next` tag instead of `latest`, and marks the GitHub release as a pre-release. A pre-release run needs a pre-release version, and a normal run a stable one, so `latest` never moves to a pre-release.

The run's summary names the version as soon as the **Release version** job finishes, and links the release once the **GitHub release** job has published it. Don't push the tag or create the release by hand: Release refuses a version that is already tagged, and tags can't be moved or deleted.

## What the run does

**Release version** stops a run started on any other branch and reads the version from `package.json`. **Verify** then requires the checked-out commit to match the run's commit, and stops before building when `v<version>` is already tagged or the version is already on npm. [validate-release.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/validate-release.mjs) also validates the package identity, repository, registry, access and lockfile metadata. Verify runs `npm ci` and `npm run test:package`, packs the build and uploads the tarball with SHA-256 checksums.

**Check** runs the [Check workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/check.yml) on the release commit as part of the run, with every job it runs on a push to `main`. Its runs inside Release are grouped apart from Check's own runs, so a push to `main` during a release doesn't cancel them.

**Publish npm** downloads the verified tarball, checks its checksum and publishes it with scripts disabled. It does not rebuild the package. **GitHub release** then creates the `v<version>` tag on the release commit and publishes a GitHub release for it with the same tarball attached.

If a job fails, inspect it before retrying, and re-run only the failed jobs so the verified package is reused. Re-running Publish npm is safe: when npm already holds this version with the same tarball, it skips npm, and it stops if npm holds a different tarball. Re-running GitHub release accepts an existing tag only on the release commit, publishes a draft left for the tag with the tarball attached, and leaves an already published release as it is. A new run, or a full re-run, stops at verification once the version is tagged or on npm, so finish a partly failed release by re-running its failed jobs within the artifact's three days. After that, bump the version, merge it to `main` and run Release again. Keep release-specific investigation and validation evidence in the tracking issue.
