# Usage

Model Profiles resolves each agent's `modelRef` to a model from `models.jsonc`. It requires Node 22.18+. This page uses OpenCode's names; [Host differences](#host-differences) lists Kilo's.

## Install

On OpenCode 1.19.x, starting at 1.19.0, add `@lunchbox-labs/opencode-model-profiles` to `plugin` in both `opencode.jsonc` (the server plugin resolves models) and `tui.jsonc` (the `/model-config` dialog and fallback toasts):

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-model-profiles"] }
```

On Kilo CLI 7.8.x, starting at 7.8.27, add `@lunchbox-labs/kilo-model-profiles` to `plugin` in both `kilo.jsonc` and Kilo's `tui.jsonc`:

```jsonc
{ "plugin": ["@lunchbox-labs/kilo-model-profiles"] }
```

Each package works only in its own host, and reads only that host's directories and variables.

## Name the model an agent uses

Set `modelRef` in an agent's Markdown frontmatter:

```markdown
---
description: Plans and implements changes
mode: primary
modelRef: reasoning
---
```

or on an agent entry in `opencode.jsonc`, built-in agents included:

```jsonc
{ "agent": { "reviewer": { "modelRef": "reasoning" } } }
```

A resolved ref sets the agent's `model`, replacing any model the agent sets itself, along with the model settings the ref names (see [Model settings](#model-settings)). Settings the ref leaves out keep the agent's own values. `modelRef` is removed before OpenCode builds the agent, so it never reaches a provider as an option.

## models.jsonc

The plugin reads `models.jsonc` from OpenCode's global config directory (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`) each time OpenCode loads a project. To use another file, pass `configFile`: an absolute path, a path that starts with `~/`, or a path resolved against that directory:

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

- `defaults` maps ref names to models. A model is `"provider/model"`, or an object with `model` and the [model settings](#model-settings) to send with it.
- `profiles` maps profile names to refs. A ref the selected profile leaves out comes from `defaults`.
- `builtins` gives refs to OpenCode's built-in agents: `build`, `plan`, `general`, `explore`, `compaction`, `title` and `summary`. A built-in can also take a `modelRef` on its entry in `opencode.jsonc`, like any other agent. That entry's `modelRef`, or a `model` it sets itself, wins over `builtins`. Built-ins with neither keep OpenCode's default model choice. Kilo's built-in agents are listed under [Host differences](#host-differences).
- `defaultProfile` (optional) names the profile used when none is saved for the worktree.

## Model settings

An object ref takes the model settings of an OpenCode agent entry, so a ref carries the agent settings its model needs:

```jsonc
{
  "defaults": {
    "reasoning": {
      "model": "openai/gpt-6-astra",
      "variant": "high",
      "options": { "reasoningSummary": "detailed" },
    },
    "coding": {
      "model": "openai/gpt-6",
      "reasoningEffort": "high",
      "textVerbosity": "low",
    },
  },
}
```

- `variant`, `temperature` and `top_p` replace the agent's own values. A request the agent sends to another model, such as a fallback or a model picked by hand, gets the agent's own `temperature` and `top_p` back, or the provider's default where the agent sets none, since some providers refuse another model's sampling settings. The ref's `options` still go with it, as an agent's options do in OpenCode.
- `options` are provider options. They merge over the agent's own `options` the way OpenCode merges them: nested objects key by key, the ref winning where both set a value. As in OpenCode, the variant's own options still win over them.
- Any other key goes into `options`, as OpenCode does for an agent entry, so `"reasoningEffort": "high"` is the same as `"options": { "reasoningEffort": "high" }`.
- Agent settings that are not about the model, such as `prompt`, `steps`, `mode` or `permission`, are left out with a notice. Set those on the agent.

The settings apply only when the ref does. A ref whose model is unavailable leaves the agent's own model and settings. A profile's ref replaces the default's whole entry, settings included, so a profile that sets `"coding": "openai/gpt-6-luna"` drops the settings `defaults.coding` has. An invalid setting is left out with a notice and the rest of the ref still applies.

Fuller examples are in [packages/opencode/examples/models.jsonc](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/opencode/examples/models.jsonc) and, for Kilo, [packages/kilo/examples/models.jsonc](https://github.com/lunchbox-labs/opencode-model-profiles/blob/main/packages/kilo/examples/models.jsonc).

[Profiles](Profiles) covers switching profiles, and [Fallbacks](Fallbacks) what happens when an entry or model can't be used.

## Host differences

Both packages behave the same apart from these host names and directories. `<config>`, `<data>`, `<state>` and `<cache>` stand for `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME` and `$XDG_CACHE_HOME`, else `~/.config`, `~/.local/share`, `~/.local/state` and `~/.cache`.

| | OpenCode | Kilo CLI |
| --- | --- | --- |
| Package | `@lunchbox-labs/opencode-model-profiles` | `@lunchbox-labs/kilo-model-profiles` |
| Plugin config files | `opencode.jsonc` and `tui.jsonc` | `kilo.jsonc` and `tui.jsonc` |
| `models.jsonc` directory | `OPENCODE_CONFIG_DIR`, else `<config>/opencode` | `KILO_CONFIG_DIR`, else `<config>/kilo` |
| Saved choices and availability | `<state>/opencode` | `<state>/kilo`, or `<data>/kilo/state` (see below) |
| Provider credentials checked | `<data>/opencode/auth.json` | `<data>/kilo/auth.json` |
| models.dev catalog | `OPENCODE_MODELS_PATH`, else `<cache>/opencode/models.json` | `KILO_MODELS_PATH`, else Kilo's cached copy in `<cache>/kilo`, which follows `KILO_MODELS_URL` |
| Profile for one process | `OPENCODE_MODEL_PROFILE` | `KILO_MODEL_PROFILE` |
| `$schema` | `https://cdn.jsdelivr.net/npm/@lunchbox-labs/opencode-model-profiles/schema.json` | `https://cdn.jsdelivr.net/npm/@lunchbox-labs/kilo-model-profiles/schema.json` |
| Built-in agents in `builtins` | `build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary` | `code`, `plan`, `debug`, `ask`, `orchestrator`, `general`, `explore`, `scout`, `compaction`, `title`, `summary` |

On Kilo:

- `build` is the old name of `code`, and still works in `builtins` and on agent entries. When both are set, `code` wins. Reports, `/model-config` and fallbacks use `code`.
- `scout` is an experimental agent. `builtins.scout` applies only when `KILO_EXPERIMENTAL` or `KILO_EXPERIMENTAL_SCOUT` is `true` or `1`, or when the config defines a `scout` agent; otherwise it is skipped with a notice.
- When `XDG_STATE_HOME` is unset and Kilo has switched to its writable `<data>/kilo/state` folder, the plugin uses that folder too, as Kilo does.
- Which providers connect also depends on the Kilo organization in use (`KILO_ORG_ID`, the account of a Kilo sign-in, or the `kilo` provider's organization setting), so availability is saved separately for each. The organization id is used only to tell setups apart and is never written to a file.

The two packages never read or move each other's files or variables, so OpenCode and Kilo keep separate saved choices on one machine.
