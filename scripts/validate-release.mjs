import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const core = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const stableVersion = new RegExp(`^${core}$`);
const prereleaseVersion = new RegExp(
  String.raw`^${core}-[0-9a-z-]+(?:\.[0-9a-z-]+)*$`,
  "i",
);

const repositoryUrl =
  "git+https://github.com/lunchbox-labs/model-profiles-plugin.git";

/** The private core: source the host packages bundle at build time. It is never published. */
export const corePackage = {
  directory: "packages/core",
  name: "@lunchbox-labs/model-profiles-core",
};
/** The published packages in publication order. */
export const releasePackages = [
  {
    directory: "packages/opencode",
    name: "@lunchbox-labs/opencode-model-profiles",
  },
  { directory: "packages/kilo", name: "@lunchbox-labs/kilo-model-profiles" },
];
/** Every workspace package, in the order validateRelease takes their manifests. */
export const workspacePackages = [corePackage, ...releasePackages];

// npm links every workspace package into the root node_modules, so the host
// packages import the core without naming it, and their published manifests
// never point at a package npm doesn't have.
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// The core keeps the release version, so the workspace has one version.
function validateCore(manifest, version, lock) {
  if (manifest?.name !== corePackage.name) {
    throw new Error(
      `The npm package name in ${corePackage.directory} must be ${corePackage.name}.`,
    );
  }
  if (manifest.private !== true) {
    throw new Error(
      `${corePackage.name} is bundled into the host packages and never published; set "private": true in ${corePackage.directory}/package.json.`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `${corePackage.name} must have the release version ${version}.`,
    );
  }
  const locked = lock?.packages?.[corePackage.directory];
  if (locked?.name !== manifest.name || locked?.version !== manifest.version) {
    throw new Error(
      `The lockfile entry for ${corePackage.directory} must match its name and version.`,
    );
  }
}

function validateManifest(expected, manifest, tag, lock, prerelease) {
  if (manifest.private !== undefined && manifest.private !== false) {
    throw new Error(
      `Private packages cannot be published; remove the private flag from ${expected.directory}/package.json.`,
    );
  }
  if (manifest.name !== expected.name) {
    throw new Error(
      `The npm package name in ${expected.directory} must be ${expected.name}.`,
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
  if (manifest.repository?.url !== repositoryUrl) {
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
  const locked = lock?.packages?.[expected.directory];
  if (locked?.name !== manifest.name || locked?.version !== manifest.version) {
    throw new Error(
      `The lockfile entry for ${expected.directory} must match its name and version.`,
    );
  }
  for (const field of dependencyFields) {
    if (
      Object.hasOwn(manifest[field] ?? {}, corePackage.name) ||
      Object.hasOwn(locked[field] ?? {}, corePackage.name)
    ) {
      throw new Error(
        `${expected.name} bundles ${corePackage.name}; remove it from ${field}.`,
      );
    }
  }
  return access;
}

// The host packages are released at one version in one run, with the core's
// manifest first to check it stays private at that version. A pre-release run
// publishes a pre-release version only, and a normal run a stable version
// only, so npm's latest tag never moves to a pre-release.
export function validateRelease(
  manifests,
  tag,
  lock,
  { prerelease = false } = {},
) {
  if (
    !Array.isArray(manifests) ||
    manifests.length !== workspacePackages.length
  ) {
    throw new Error(
      `A release checks ${workspacePackages.map(({ name }) => name).join(", ")}, in that order.`,
    );
  }
  const [core, ...published] = manifests;
  const accesses = releasePackages.map((expected, index) =>
    validateManifest(expected, published[index], tag, lock, prerelease),
  );
  validateCore(core, published[0].version, lock);
  const [access] = accesses;
  if (accesses.some((other) => other !== access)) {
    throw new Error("Every package must have the same publishConfig.access.");
  }
  // Each version equals the tag's, so they are all the same.
  return {
    names: releasePackages.map(({ name }) => name),
    version: published[0].version,
    access,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (path) =>
    JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const result = validateRelease(
    workspacePackages.map(({ directory }) => read(`${directory}/package.json`)),
    process.env.RELEASE_TAG,
    read("package-lock.json"),
    { prerelease: process.env.RELEASE_PRERELEASE === "true" },
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `access=${result.access}\nnames=${result.names.join(" ")}\nversion=${result.version}\n`,
    );
  }
  console.log(
    `Validated ${result.names.map((name) => `${name}@${result.version}`).join(", ")} for ${result.access} publication.`,
  );
}
