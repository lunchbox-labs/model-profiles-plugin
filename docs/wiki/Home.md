# Model Profiles

Choose agent models by name: give each agent a `modelRef`, map refs to models in one `models.jsonc`, and switch between profiles of concrete models per worktree with `/model-config`. These guides describe the current repository; published packages may differ.

The plugin is published for two hosts, with the same features:

- OpenCode 1.19.x: `@lunchbox-labs/opencode-model-profiles`.
- Kilo CLI 7.8.x: `@lunchbox-labs/kilo-model-profiles`.

The pages use OpenCode's names. [Host differences](Usage#host-differences) lists the config files, directories, variables and built-in agents that differ on Kilo.

## User documentation

- [Usage](Usage): installation, `modelRef`, `models.jsonc` and host differences.
- [Profiles](Profiles): picking a profile, where the choice is saved and precedence.
- [Fallbacks](Fallbacks): what happens when the configuration or a model can't be used.

## Developer documentation

- [Developer](Developer): the workspace, development and compatibility testing.
- [Publishing](Publishing): trusted publisher setup and the release workflow.
