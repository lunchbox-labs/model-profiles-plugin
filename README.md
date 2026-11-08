# OpenCode Model Profiles

Choose agent models by name: give each agent a `modelRef`, map refs to models in one `models.jsonc`, and switch between profiles of concrete models per worktree with `/model-config`.

Requires Node **22.18+**. Built for OpenCode **1.19.x**, starting at **1.19.0**.

## Install

Add the package to `plugin` in both `opencode.jsonc` (the server plugin resolves models) and `tui.jsonc` (the `/model-config` dialog and fallback toasts):

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-model-profiles"] }
```

## Quick start

Set `modelRef` in an agent's Markdown frontmatter, or on its entry in `opencode.jsonc`:

```markdown
---
description: Plans and implements changes
mode: primary
modelRef: reasoning
---
```

Map refs to models in `models.jsonc` in OpenCode's global config directory, with optional profiles that override them:

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/@lunchbox-labs/opencode-model-profiles/schema.json",
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

Run `/model-config` to pick a profile for the current worktree. Problems in the configuration never stop OpenCode: affected agents fall back to the model OpenCode would give them, and the TUI shows a toast saying why. [Fallbacks](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Fallbacks) covers models no connected provider offers.

## Documentation

The [wiki](https://github.com/lunchbox-labs/opencode-model-profiles/wiki) has the full guides:

- [Usage](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Usage): `modelRef`, every `models.jsonc` field, built-in agents and the `configFile` option.
- [Profiles](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Profiles): the `/model-config` picker, saved choices and precedence.
- [Fallbacks](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Fallbacks): invalid entries, unavailable models and the toasts that report them.
- [Developer](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Developer): development, compatibility testing and publishing.

A fuller example is in [docs/examples/models.jsonc](docs/examples/models.jsonc).
