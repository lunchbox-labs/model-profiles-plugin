# Model Profiles

Choose agent models by name: give each agent a `modelRef`, map refs to models in one `models.jsonc`, and switch between profiles of concrete models per worktree with `/model-config`.

| Host            | Package                                                     |
| --------------- | ----------------------------------------------------------- |
| OpenCode 1.19.x | [@lunchbox-labs/opencode-model-profiles](packages/opencode) |
| Kilo CLI 7.8.x  | [@lunchbox-labs/kilo-model-profiles](packages/kilo)         |

Both bundle the shared source in [packages/core](packages/core), which is not published on its own. The [wiki](https://github.com/lunchbox-labs/opencode-model-profiles/wiki) covers installation, usage and development for both hosts.
