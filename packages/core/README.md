# Model Profiles core

The shared logic of [@lunchbox-labs/opencode-model-profiles](https://www.npmjs.com/package/@lunchbox-labs/opencode-model-profiles) and [@lunchbox-labs/kilo-model-profiles](https://www.npmjs.com/package/@lunchbox-labs/kilo-model-profiles). It is not a plugin on its own: install the package for your host, which depends on this one at the same version.

Each host package passes a `Host` profile (its name, config file, directory and variable names, built-in agents and provider details) to `createServerPlugin` and `createTuiPlugin`. The core imports host types only, and its one runtime dependency is `jsonc-parser`.

The [wiki](https://github.com/lunchbox-labs/opencode-model-profiles/wiki) covers usage, and its [Developer](https://github.com/lunchbox-labs/opencode-model-profiles/wiki/Developer) page the workspace layout.
