# Developer documentation

For contributors and maintainers working on Model Profiles:

- [Local builds and checks](#build-a-local-package): local builds, the server and TUI plugins and compatibility checks.
- [Publishing](Publishing): trusted publisher setup and the release workflow.

The plugin's state machines are documented in [docs/state-machines.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/docs/state-machines.md). These wiki pages are published from [docs/wiki](https://github.com/lunchbox-labs/opencode-model-profiles/tree/main/docs/wiki) on every push to `main` that changes them; change them there.

The repository's [AGENTS.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/AGENTS.md) and linked shared standards remain the authoritative machine instructions. [User documentation](Home#user-documentation) covers installation and everyday use.

## Build a local package

Use the committed npm lockfile. CI uses Node 24; the package requires Node 22.18 or later.

```sh
npm ci
npm run build
npm pack
```

Install the generated tarball into a separate directory and register that installed package's absolute directory in both `opencode.jsonc` and `tui.jsonc`. OpenCode selects the corresponding server or TUI export. This exercises a local candidate without publishing it.

## Package shape

The package has a server plugin (the root and `./server` exports) that resolves each agent's `modelRef` in the `config` hook and handles fallbacks, and a TUI plugin (`./tui`) for `/model-config` and fallback toasts. The server publishes what it applied in its own `plugin` entry's options, which the TUI reads. [AGENTS.md](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/AGENTS.md) describes the contracts these hooks keep. [schema.json](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/schema.json) ships in the package for editor validation of `models.jsonc`.

## Checks

| Command | Coverage |
| --- | --- |
| `npm run check` | Typechecking, lint, formatting and unit tests |
| `npm run test:package` | Built tarball installation, the server and TUI exports and declarations |

Tests should protect observable behavior, safety boundaries and host contracts. The [shared standards](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md#meaningful-tests) define the testing policy.

## Host compatibility

The supported OpenCode range and floor live in [tests/opencode.json](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/tests/opencode.json). The `@opencode-ai/plugin` and `@opencode-ai/sdk` dev dependencies share one exact version inside that range. The `@opentui/*` and `solid-js` dev dependencies stay on the versions the supported host bundles, because OpenCode maps a plugin's imports of them to its own copies. [tests/opencode-baseline.test.mjs](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/tests/opencode-baseline.test.mjs) enforces both, so update them only together with the supported range. The built-in agent names in `src/models-file.ts` and `schema.json` also follow the supported host. No OpenCode runtime engine restriction is declared.

[Check CI](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/.github/workflows/check.yml) runs the unit and package tests on Linux and Windows for every pull request and push to `main`, and the static checks on Linux.
