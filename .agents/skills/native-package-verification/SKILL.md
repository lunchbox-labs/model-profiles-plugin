---
name: native-package-verification
description: Use when verifying changes to server or TUI behavior, host integration, package exports, or distributed files.
---

Read the root package.json, the affected packages/*/package.json, tests/package.integration.ts and the affected tests before selecting checks. Use the committed lockfile and supported Node version; install with npm ci when needed. Do not change dependencies, versions, or security exceptions to make checks pass.

Run npm run check for static and unit checks across every package. Run npm run test:package for exports or distribution changes; inspect the packed file lists and exercise the packed packages rather than relying on source imports. Keep root .agents, .codex, .claude, .kilo, .opencode and CLAUDE.md contributor files out of the packages. Keep the root and ./server exports of each host package on the server plugin and ./tui on the TUI plugin, and keep the core free of runtime host imports.

For server, TUI or host integration changes, check each host the change affects; a change in packages/core affects both. For OpenCode, load the built plugin from opencode.jsonc and tui.jsonc in a real OpenCode host within the range in packages/opencode/tests/opencode.json. For Kilo, load it from kilo.jsonc and Kilo's tui.jsonc in a real Kilo CLI host within the range in packages/kilo/tests/kilo.json. Use an isolated project and configuration. Do not invoke paid model/API calls, and do not call tools that change files or external state while verifying. Report unavailable hosts or blocked checks rather than replacing native evidence with a mock.

Report commands, exit results, host and version, observed server, TUI or package evidence, and any skipped or unavailable checks. Distinguish source inference, unit/packed tests and native runtime observations. Keep detailed task evidence on the linked issue, not in committed plan documents.
