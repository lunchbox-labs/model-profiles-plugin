# Kilo Model Profiles

Choose agent models by name: give each agent a `modelRef`, map refs to models in one `models.jsonc`, and switch between profiles of concrete models per worktree with `/model-config`.

Requires Node **22.18+**. Built for Kilo CLI **7.8.x**, starting at **7.8.27**. For OpenCode, use [@lunchbox-labs/opencode-model-profiles](https://www.npmjs.com/package/@lunchbox-labs/opencode-model-profiles) instead.

## Install

Add the package to `plugin` in both `kilo.jsonc` (the server plugin resolves models) and Kilo's `tui.jsonc` (the `/model-config` dialog and fallback toasts):

```jsonc
{ "plugin": ["@lunchbox-labs/kilo-model-profiles"] }
```

## Quick start

Set `modelRef` in an agent's Markdown frontmatter, or on its entry in `kilo.jsonc`:

```markdown
---
description: Plans and implements changes
mode: primary
modelRef: reasoning
---
```

Map refs to models, and any model settings Kilo sends with them, in `models.jsonc` in Kilo's global config directory (`~/.config/kilo` by default), with optional profiles that override them:

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/@lunchbox-labs/kilo-model-profiles/schema.json",
  "defaults": {
    "reasoning": { "model": "openai/gpt-6-astra", "variant": "high" },
    "coding": "openai/gpt-5.6-sol",
  },
  "profiles": {
    "anthropic-latest": {
      "reasoning": { "model": "anthropic/claude-opus-5-5", "variant": "high" },
    },
  },
}
```

Run `/model-config` to pick a profile for the current worktree. Problems in the configuration never stop Kilo: affected agents fall back to the model Kilo would give them, and the TUI shows a toast saying why. [Fallbacks](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Fallbacks) covers models no connected provider offers.

## Documentation

The [wiki](https://github.com/lunchbox-labs/model-profiles-plugin/wiki) covers OpenCode and Kilo; [Usage](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Usage#host-differences) lists what differs on Kilo, such as the `KILO_*` variables, the `code` agent that replaces `build`, and `scout`.

- [Usage](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Usage): `modelRef`, every `models.jsonc` field, built-in agents and the `configFile` option.
- [Profiles](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Profiles): the `/model-config` picker, saved choices and precedence.
- [Fallbacks](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Fallbacks): invalid entries, unavailable models and the toasts that report them.
- [Developer](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Developer): development, compatibility testing and publishing.

A fuller example is in [examples/models.jsonc](https://github.com/lunchbox-labs/model-profiles-plugin/blob/main/packages/kilo/examples/models.jsonc).
