# Usage

Model Profiles resolves each agent's `modelRef` to a model from `models.jsonc`. It requires Node 22.18+ and is built for OpenCode 1.19.x, starting at 1.19.0.

## Install

Add the package to `plugin` in both `opencode.jsonc` (the server plugin resolves models) and `tui.jsonc` (the `/model-config` dialog and fallback toasts):

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-model-profiles"] }
```

## Name the model an agent uses

Set `modelRef` in an agent's Markdown frontmatter:

```markdown
---
description: Plans and implements changes
mode: primary
modelRef: reasoning
---
```

or on an agent entry in `opencode.jsonc`:

```jsonc
{ "agent": { "reviewer": { "modelRef": "reasoning" } } }
```

A resolved ref sets the agent's `model`, replacing any model the agent sets itself, and its `variant` when the ref names one; otherwise the agent's own `variant` stays. `modelRef` is removed before OpenCode builds the agent, so it never reaches a provider as an option.

## models.jsonc

The plugin reads `models.jsonc` from OpenCode's global config directory (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`) each time OpenCode loads a project. To use another file, pass `configFile`, resolved against that directory:

```jsonc
{
  "plugin": [
    [
      "@lunchbox-labs/opencode-model-profiles",
      { "configFile": "models/work.jsonc" },
    ],
  ],
}
```

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/@lunchbox-labs/opencode-model-profiles/schema.json",
  "defaults": {
    "reasoning": { "model": "openai/gpt-6-astra", "variant": "high" },
    "coding": "openai/gpt-5.6-sol",
    "system": "openai/gpt-5.6-terra",
  },
  "profiles": {
    "anthropic-latest": {
      "reasoning": { "model": "anthropic/claude-opus-5-5", "variant": "high" },
      "coding": "anthropic/claude-sonnet-5-5",
    },
  },
  "builtins": { "general": "coding", "title": "system" },
}
```

- `defaults` maps ref names to models. A model is `"provider/model"` or `{ "model": "provider/model", "variant": "high" }`.
- `profiles` maps profile names to refs. A ref the selected profile leaves out comes from `defaults`.
- `builtins` gives refs to OpenCode's built-in agents: `build`, `plan`, `general`, `explore`, `compaction`, `title` and `summary`. An agent entry that sets its own `modelRef` or `model` wins. Built-ins without a ref keep OpenCode's default model choice.
- `defaultProfile` (optional) names the profile used when none is saved for the worktree.

A fuller example is in [docs/examples/models.jsonc](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/docs/examples/models.jsonc).

[Profiles](Profiles) covers switching profiles, and [Fallbacks](Fallbacks) what happens when an entry or model can't be used.
