# Model Profiles core

Internal source shared by [@lunchbox-labs/opencode-model-profiles](../opencode) and [@lunchbox-labs/kilo-model-profiles](../kilo). It is a private workspace package and is never published: each host package's build (tsdown) inlines it into that package's `dist/`.

Each host package passes a `Host` profile (its name, config file, directory and variable names, built-in agents and provider details) to `createServerPlugin` and `createTuiPlugin`. The core imports host types only, and its one runtime dependency is `jsonc-parser`, which each host package lists in its own `dependencies`, since the bundle imports it.

The wiki's [Developer](https://github.com/lunchbox-labs/model-profiles-plugin/wiki/Developer) page covers the workspace layout.
