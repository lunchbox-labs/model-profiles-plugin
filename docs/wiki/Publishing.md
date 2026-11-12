# Publishing

The [Release workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/release.yml) runs only when started by hand on `main`. It releases the three workspace packages at the version they share, in one run: it publishes `@lunchbox-labs/model-profiles-core`, `@lunchbox-labs/opencode-model-profiles` and `@lunchbox-labs/kilo-model-profiles` to npm in that order, creates the `v<version>` tag on the release commit, and publishes a GitHub release for that tag with the three package tarballs attached and notes generated from the merged pull requests. Branch pushes, pull requests and tag pushes do not publish packages.

## Publisher setup

The workflow expects these settings, configured through the respective services. This page describes the required setup, not confirmation of its current state.

- **npm trusted publishers:** one for each of the three packages, each with organization `lunchbox-labs`, repository `opencode-model-profiles`, workflow filename `release.yml` and environment `release`. Allow direct `npm publish`, which is the command this workflow uses. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
- **`release` environment:** allows deployments from `main` only. It holds no secrets or variables.
- **Actions policy:** only maintainers may start Release, and Wiki may run only on pushes to `main`. Both can write to the repository.
- **Tag rulesets:** a ruleset blocks updating and deleting `v*` tags. No ruleset blocks creating them, because Release creates the tag itself.

The publish job has `id-token: write` for OIDC and `contents: read`. It installs a trusted-publishing-capable npm version and enables provenance. The workflow does not use a long-lived npm token. Only the GitHub release job has `contents: write`, and it runs no repository code. Both jobs run in the `release` environment.

## Bootstrap a new package name

npm adds a trusted publisher only to a package that already exists, and Release stops at verification while any of the three packages has never been published. `@lunchbox-labs/model-profiles-core` and `@lunchbox-labs/kilo-model-profiles` were added in 0.3.0 and need this once each before their first Release run:

1. Publish a throwaway pre-release of the package by hand under its own dist-tag: in a checkout with the package built, set its version to `0.0.0-bootstrap.0` without committing the change, and run `npm publish --tag bootstrap` in its directory, signed in to npm as a maintainer of the `lunchbox-labs` organization.
2. In the package's settings on npm, add the trusted publisher described above.
3. Run Release with **dry_run** to confirm verification passes, then run it for real.

The bootstrap version is never released from this repository, so it can't collide with a real version.

## Prepare and run a release

1. Set one version in `packages/core/package.json`, `packages/opencode/package.json` and `packages/kilo/package.json`, set the host packages' dependency on `@lunchbox-labs/model-profiles-core` to that exact version, and run `npm install` so `package-lock.json` matches. Use a non-placeholder semantic version that has no tag and isn't on npm for any of the three packages yet: a stable version such as `1.2.3` for a release, or a pre-release version such as `1.2.3-beta.1` for a pre-release.
2. Complete the required checks and review, and integrate the release commit into `main` through the repository's normal process.
3. Open **Actions**, choose **Release**, and select **Run workflow** with `main` as the branch. The run releases the commit at the head of `main` when it starts, so start it once the release commit is the latest commit there. Run it once per version.

The run has two inputs:

- **dry_run:** builds and checks the release, then stops before npm, the tag and the GitHub release.
- **prerelease:** publishes under npm's `next` tag instead of `latest`, and marks the GitHub release as a pre-release. A pre-release run needs a pre-release version, and a normal run a stable one, so `latest` never moves to a pre-release.

The run's summary names the version as soon as the **Release version** job finishes, and links the release once the **GitHub release** job has published it. Don't push the tag or create the release by hand: Release refuses a version that is already tagged, and tags can't be moved or deleted.

## What the run does

**Release version** stops a run started on any other branch, reads the version from the three packages' `package.json` files and stops when they differ. **Verify** then requires the checked-out commit to match the run's commit, and stops before building when `v<version>` is already tagged, any of the three packages already has the version on npm, or any of them is not on npm at all (see [Bootstrap a new package name](#bootstrap-a-new-package-name)), so a run never publishes some packages and then fails on the next. [validate-release.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/validate-release.mjs) also validates each package's identity, repository, registry, access and lockfile metadata, and that both host packages depend on the core at exactly the release version. Verify runs `npm ci` and `npm run test:package`, packs the three packages and uploads the tarballs with SHA-256 checksums.

**Check** runs the [Check workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/check.yml) on the release commit as part of the run, with every job it runs on a push to `main`. Its runs inside Release are grouped apart from Check's own runs, so a push to `main` during a release doesn't cancel them.

**Publish npm** downloads the verified tarballs, checks their checksums and publishes them with scripts disabled, the core first so the host packages never point at a core that isn't on npm. It does not rebuild the packages. **GitHub release** then creates the `v<version>` tag on the release commit and publishes a GitHub release for it with the same tarballs attached.

If a job fails, inspect it before retrying, and re-run only the failed jobs so the verified packages are reused. Re-running Publish npm is safe: for each package that npm already holds at this version with the same tarball, it skips npm, and it stops if npm holds a different tarball, so a run that published only some of the packages finishes the rest. Re-running GitHub release accepts an existing tag only on the release commit, publishes a draft left for the tag with the tarballs attached, and leaves an already published release as it is. A new run, or a full re-run, stops at verification once the version is tagged or any package has it on npm, so finish a partly failed release by re-running its failed jobs within the artifact's three days. After that, bump the version, merge it to `main` and run Release again. Keep release-specific investigation and validation evidence in the tracking issue.
