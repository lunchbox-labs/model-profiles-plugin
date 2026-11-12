import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const core = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const stableVersion = new RegExp(`^${core}$`);
const prereleaseVersion = new RegExp(
  String.raw`^${core}-[0-9a-z-]+(?:\.[0-9a-z-]+)*$`,
  "i",
);

// A pre-release run publishes a pre-release version only, and a normal run a
// stable version only, so npm's latest tag never moves to a pre-release.
export function validateRelease(
  manifest,
  tag,
  lock,
  { prerelease = false } = {},
) {
  if (manifest.private !== undefined && manifest.private !== false) {
    throw new Error(
      "Private packages cannot be published; remove the private flag from package.json.",
    );
  }
  if (manifest.name !== "@lunchbox-labs/opencode-model-profiles") {
    throw new Error(
      "The npm package name must be @lunchbox-labs/opencode-model-profiles.",
    );
  }
  if (typeof manifest.version !== "string" || manifest.version === "0.0.0") {
    throw new Error("Publishing requires a non-placeholder semantic version.");
  }
  if (prerelease && !prereleaseVersion.test(manifest.version)) {
    throw new Error(
      "A pre-release requires a pre-release semantic version, such as 1.2.3-beta.1.",
    );
  }
  if (!prerelease && !stableVersion.test(manifest.version)) {
    throw new Error(
      "A release requires a stable semantic version; publish pre-release versions as a pre-release.",
    );
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error(
      "The release tag must equal v followed by the package version.",
    );
  }
  const access = manifest.publishConfig?.access;
  if (
    !["public", "restricted"].includes(access) ||
    (access === "restricted" && !manifest.name.startsWith("@"))
  ) {
    throw new Error(
      "Set an approved publishConfig.access; restricted packages require a scope.",
    );
  }
  if (
    manifest.repository?.url !==
    "git+https://github.com/lunchbox-labs/opencode-model-profiles.git"
  ) {
    throw new Error(
      "The package repository must match the trusted publisher repository.",
    );
  }
  if (
    manifest.publishConfig?.registry !== undefined &&
    manifest.publishConfig.registry !== "https://registry.npmjs.org"
  ) {
    throw new Error(
      "This workflow publishes only to https://registry.npmjs.org.",
    );
  }
  if (
    lock?.name !== manifest.name ||
    lock?.version !== manifest.version ||
    lock?.packages?.[""]?.name !== manifest.name ||
    lock?.packages?.[""]?.version !== manifest.version
  ) {
    throw new Error(
      "The lockfile package name and version must match the release manifest.",
    );
  }
  return { name: manifest.name, version: manifest.version, access };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const result = validateRelease(manifest, process.env.RELEASE_TAG, lock, {
    prerelease: process.env.RELEASE_PRERELEASE === "true",
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `access=${result.access}\nname=${result.name}\nversion=${result.version}\n`,
    );
  }
  console.log(
    `Validated ${result.name}@${result.version} for ${result.access} publication.`,
  );
}
