# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/npm-packages.md)
- [Agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

`npm run check` includes static checks and unit tests. Run `npm run test:package` separately for packed-package validation.

The package has a server plugin (the root and `./server` exports) and a TUI plugin (`./tui`), so users add it to `plugin` in both `opencode.jsonc` and `tui.jsonc`.

The server `config` hook resolves each agent's `modelRef` and must never throw. It replaces `config.agent` with new objects instead of editing agents in place, because OpenCode keeps the global config's agent objects for the whole process and a stripped `modelRef` would be lost on the next reload. It publishes what it applied in its own `plugin` entry's options (`src/report.ts`), which the TUI reads through `/config` for `/model-config` and fallback toasts. The built-in agent names in `src/models-file.ts` and `schema.json` follow the supported OpenCode host. Providers load after the `config` hook, so `src/fallback.ts` checks refs against connected providers on the first event and in `chat.message`, saves that availability per directory and provider setup (`providerSetupKey`, which reads no secret values) in the state directory for the next `config` hook, moves a prompt off an unavailable model (toasting it through `client.tui.showToast` once per process, since clients without the TUI plugin never see the report), and reloads the instance once no session is busy and no PTY is open (tried again when a session goes idle or a PTY exits or is removed, at most three refused disposes per instance, never twice for the same availability).

The `@opentui/*` and `solid-js` dev dependencies must stay on the versions the supported OpenCode host bundles; `tests/opencode-baseline.test.mjs` enforces this. Update them only together with the supported host range in `tests/opencode.json`.

Write documentation for knowledgeable OpenCode users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Omit maintainer publishing and release-process walkthroughs; release notes are still appropriate.

## Contributor workflows

Request an independent `opencode-user-review` for changes to model refs, `models.jsonc` defaults, profiles or built-in agent settings, the profile picker, fallbacks, toasts or user-facing documentation; unrelated changes do not need it. Give the reviewer the diff/base and relevant test or runtime evidence.

Use `.agents/skills/native-package-verification/SKILL.md` to select applicable package and host checks; it is not an additional review role. The [agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md) cover the file layout, invocation in each tool and reviewer permissions.
