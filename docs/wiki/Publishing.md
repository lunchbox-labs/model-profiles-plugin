# Publishing

The [Publish workflow](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/publish.yml) runs when a stable `v<version>` tag is pushed. It publishes `@lunchbox-labs/opencode-model-profiles` to npm and opens a draft GitHub release for the tag with the published package tarball attached. Branch pushes, pull requests and prerelease tags do not publish packages.

## Publisher setup

The workflow expects a GitHub `npm` environment and an npm trusted publisher for this package. Match the publisher to organization `lunchbox-labs`, repository `opencode-model-profiles`, workflow filename `publish.yml`, and environment `npm`. Allow direct `npm publish`, which is the command this workflow uses. Configure those settings through the respective services; this page describes the required identity, not confirmation of its current setup. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

The publish job has `id-token: write` for OIDC and `contents: read`. It installs a trusted-publishing-capable npm version and enables provenance. The workflow does not use a long-lived npm token. Only the draft release job has `contents: write`, and it runs no repository code.

## Prepare and publish a release

1. Keep the version in `package.json` and both root version entries in `package-lock.json` aligned. Use a non-placeholder stable semantic version.
2. Complete the required checks and review, and integrate the release commit into `main` through the repository's normal process.
3. When authorized to release, tag the release commit on `main` and push only that tag, one version per push. Check that `origin/main` is still the release commit; otherwise tag that commit's SHA instead:

   ```sh
   git fetch origin
   git tag v<version> origin/main
   git push origin v<version>
   ```

   Tags can't be moved or deleted, so a tag on a commit that isn't on `main` fails Publish and that version has to be bumped. Don't create the release by hand: a release created that way is published at once and can't take the package tarball.
4. Review the draft release the workflow creates, edit its generated notes if needed, and publish it. Publishing the draft does not run the workflow again.

Verification requires the tag to match the package version, its commit to be on `main`, and the checked-out commit to match the triggering workflow commit. [validate-release.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/validate-release.mjs) also validates the package identity, repository, registry, access and lockfile metadata.

The verification job runs `npm ci`, `npm run check` and `npm run test:package`. It packs the verified build and uploads a tarball with SHA-256 checksums. The separate publish job downloads that artifact, verifies its checksum and publishes it with scripts disabled and the `latest` tag. It does not rebuild the package. The draft release job then attaches the same tarball to a draft release for the tag, with generated notes.

If a job fails, inspect it before retrying. Re-running is safe: when npm already holds this version with the same tarball, the publish job skips npm, and it stops if npm holds a different tarball. The draft release job reuses an existing draft for the tag and leaves an already published release unchanged. Re-run only the failed jobs so the verified package is reused. Once that artifact expires after three days, a full re-run should rebuild the same tarball; if it doesn't, the publish job stops rather than republishing. Keep release-specific investigation and validation evidence in the tracking issue.

## Release commit checks

Before publishing, Publish uses [scripts/release-ci.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/release-ci.mjs) to wait up to 40 minutes for the release commit's push run of **Check**. Only the latest run counts, and it must succeed before publication can proceed. Transient GitHub API errors are retried; five consecutive errors fail the gate.

If Check was cancelled, re-run it on the release commit, then re-run Publish.
