# OpenCode Model Profiles

Choose agent models by name: give each agent a `modelRef`, map refs to models in one `models.jsonc`, and switch between profiles of concrete models per worktree with `/model-config`.

Requires Node **22.18+**. Built for OpenCode **1.19.x**, starting at **1.19.0**.

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

A fuller example is in [docs/examples/models.jsonc](docs/examples/models.jsonc).

## Pick a profile

Run `/model-config` (**Model config** in the command palette). It lists **Defaults only** and each profile, with the current one marked along with where it came from, then every ref with the model it resolves to and the agents that use it, then any fallbacks.

Picking a profile saves it for the current worktree in OpenCode's state directory and reloads the project so it applies at once. If a session is busy, the choice is saved, marked **saved, applies on reload**, and applies the next time OpenCode reloads the project; pick it again once the session is idle to apply it now. When `defaultProfile` is set and a choice is saved, **Follow defaultProfile** forgets the saved choice.

`OPENCODE_MODEL_PROFILE=<profile>` selects a profile for one OpenCode process and overrides the saved choice. `/model-config` shows when it is set; a pick made then is saved for later processes.

Precedence: `OPENCODE_MODEL_PROFILE`, then the saved worktree choice, then `defaultProfile`, then defaults only. A profile that `models.jsonc` does not define is skipped in favour of the next.

## Fallbacks

Problems in the configuration never stop OpenCode. A missing or unparsable `models.jsonc`, an invalid entry or a ref that resolves nowhere leaves the affected agents as OpenCode would configure them; invalid entries are skipped one by one, so the rest of the file still applies. An undefined profile is skipped as described above.

The plugin does not check that a model exists when it applies a ref, so an agent whose ref names a model no connected provider offers fails when used. The TUI warns about such refs.

The TUI shows a warning toast with the first new problem and how many more there are. A problem is toasted once per OpenCode launch, and again after it changes; `/model-config` lists all current ones.
