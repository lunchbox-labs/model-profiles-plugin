# Developer documentation

For contributors and maintainers working on Model Profiles:

- [Workspace layout](#workspace-layout): the private core and the two host packages.
- [Local builds and checks](#build-a-local-package): local builds, tests for each host and compatibility checks.
- [Publishing](Publishing): trusted publisher setup and the release workflow.

The plugin's state machines are documented in [docs/state-machines.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/docs/state-machines.md). These wiki pages are published from [docs/wiki](https://github.com/lunchbox-labs/opencode-model-profiles/tree/main/docs/wiki) on every push to `main` that changes them; change them there.

The repository's [AGENTS.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/AGENTS.md) and linked shared standards remain the authoritative machine instructions. [User documentation](Home#user-documentation) covers installation and everyday use.

## Workspace layout

The repository is an npm workspace with one lockfile. All three packages share one version. The two host packages are released together; the core is private source that each host package's build inlines, and it is never published.

| Directory | Package | Contents |
| --- | --- | --- |
| `packages/core` | `@lunchbox-labs/model-profiles-core` (private) | All plugin logic, the `Host` profile type and `createServerPlugin` and `createTuiPlugin` |
| `packages/opencode` | `@lunchbox-labs/opencode-model-profiles` | OpenCode's `Host` profile, the server and TUI entries, `schema.json` and an example |
| `packages/kilo` | `@lunchbox-labs/kilo-model-profiles` | Kilo's `Host` profile, the server and TUI entries, `schema.json` and an example |

The root holds the shared tooling (TypeScript, tsdown, ESLint, Prettier and the test runner), the build config `tsdown.config.mjs`, the [release validation script](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/scripts/validate-release.mjs) and the tests that cover several packages: `tests/package.integration.ts` and `tests/release.test.mjs`.

A host package only describes its host in `src/host.ts`: its name, config file, directory and variable names, built-in agents, and hooks such as Kilo's renamed and experimental agents, extra provider variables and organization. Its `server.ts` and `tui.ts` pass that profile to the core. Behaviour belongs in the core, so both hosts get it; prefer data in the profile over host checks in the core. The core imports host types only (`import type`), so it has no runtime dependency on either host, and `jsonc-parser` is its one dependency. Each host package lists `jsonc-parser` in its own `dependencies` at the same caret range, because the bundled core imports it. Neither the core nor the host packages have peer dependencies.

The host packages don't name the core in their manifests. npm links every workspace package into the root `node_modules`, and the core's `exports` point at its TypeScript source, so imports of `@lunchbox-labs/model-profiles-core` resolve to `packages/core/src` and the core needs no build of its own. Each host package's `npm run build` runs tsdown with the root `tsdown.config.mjs`: it builds the `server` and `tui` entries to `dist/server.js`, `dist/tui.js` and their `.d.ts` files (ESM for Node 22.18), inlines the core's JavaScript and types, and keeps every other import external: Node built-ins, `jsonc-parser` and the host's `@opencode-ai/*` or `@kilocode/*` types. The core goes into one shared chunk in `dist/` that both entries import, so the server and TUI entries share one copy of its module state, as separate per-file output did. The build fails if any code from `node_modules` would be inlined.

Typechecking and lint read the core's source through the same workspace link. The core is typed against OpenCode's types, and the Kilo package's `typecheck` also checks the core's source against Kilo's (`packages/kilo/tsconfig.core.json` maps `@opencode-ai/plugin` to `@kilocode/plugin` and `@opentui/*` to Kilo's copies), so a core change that fits only one host's API fails there. The package scripts run the root TypeScript, since a dependency installs an older TypeScript in `packages/kilo/node_modules`. The tests import the core's source, so `npm test` needs no build.

## Build a local package

Use the committed npm lockfile. CI uses Node 24; the packages require Node 22.18 or later.

```sh
npm ci
npm run build
npm pack --workspace packages/opencode --workspace packages/kilo
```

`npm run build` builds the OpenCode and Kilo packages, each with the core inlined. Install a host package's tarball into a separate directory, and register that installed host package's absolute directory in both of its host's plugin config files (`opencode.jsonc` and `tui.jsonc`, or `kilo.jsonc` and Kilo's `tui.jsonc`). The host selects the corresponding server or TUI export. This exercises a local candidate without publishing it.

## Package shape

Each host package has a server plugin (the root and `./server` exports) that resolves each agent's `modelRef` in the `config` hook and handles fallbacks, and a TUI plugin (`./tui`) for `/model-config` and fallback toasts. The server publishes what it applied in its own `plugin` entry's options, which the TUI reads. [AGENTS.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/AGENTS.md) describes the contracts these hooks keep. Each host package ships its own `schema.json` for editor validation of `models.jsonc`, with that host's built-in agents.

## Checks

Run these from the repository root. Each covers every package unless it names a host.

| Command | Coverage |
| --- | --- |
| `npm run check` | Typechecking, lint, formatting and unit tests |
| `npm test` | Unit tests of every package, the release script tests |
| `npm run test:opencode` | The OpenCode package's tests, which also cover most core behaviour |
| `npm run test:kilo` | The Kilo package's tests: Kilo's directories, variables, agents and organization |
| `npm run test:package` | Packed tarballs: installing each host package on its own outside the workspace, the server and TUI exports and declarations, and that the core is inlined once and never named or installed |

Run `npm test` for a change to the core, since it reaches both hosts. Tests should protect observable behavior, safety boundaries and host contracts. The [shared standards](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md#meaningful-tests) define the testing policy.

## Host compatibility

Each host package keeps its supported range and floor next to its tests: [packages/opencode/tests/opencode.json](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/opencode/tests/opencode.json) (OpenCode 1.19.x, from 1.19.0) and [packages/kilo/tests/kilo.json](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/kilo/tests/kilo.json) (Kilo `>=7.8.27 <7.9.0`). Its plugin and SDK dev dependencies (`@opencode-ai/*` or `@kilocode/*`) share one exact version inside that range. Its `@opentui/*` and `solid-js` dev dependencies stay on the versions that host bundles, because the host maps a plugin's imports of them to its own copies: 0.4.5 for OpenCode and 0.5.11 for Kilo. The baseline tests, [opencode-baseline.test.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/opencode/tests/opencode-baseline.test.mjs) and [kilo-baseline.test.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/kilo/tests/kilo-baseline.test.mjs), check these against the manifest and what npm resolved in the lockfile, so update them only together with the supported range. The core's type-only dev dependencies follow OpenCode's. The built-in agent names in each host's `src/host.ts` and `schema.json` also follow the supported host. No host runtime engine restriction is declared.

[Check CI](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/check.yml) runs the unit and package tests of every package on Linux and Windows for every pull request and push to `main`, and the static checks on Linux.
