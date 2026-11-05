---
name: native-package-verification
description: Use when verifying changes to server or TUI behavior, host integration, package exports, or distributed files.
---

Read package.json, tests/package.integration.ts and the affected tests before selecting checks. Use the committed lockfile and supported Node version; install with npm ci when needed. Do not change dependencies, versions, or security exceptions to make checks pass.

Run npm run check for static and unit checks. Run npm run test:package for exports or distribution changes; inspect the packed file list and exercise the packed package rather than relying on source imports. Keep root .agents, .codex, .claude, .opencode and CLAUDE.md contributor files out of the package. Keep the root and ./server exports on the server plugin and ./tui on the TUI plugin.

For server, TUI or host integration changes, load the built plugin from opencode.jsonc and tui.jsonc in a real OpenCode host within the range in tests/opencode.json, using an isolated project and configuration. Do not invoke paid model/API calls, and do not call tools that change files or external state while verifying. Report unavailable hosts or blocked checks rather than replacing native evidence with a mock.

Report commands, exit results, host version, observed server, TUI or package evidence, and any skipped or unavailable checks. Distinguish source inference, unit/packed tests and native runtime observations. Keep detailed task evidence on the linked issue, not in committed plan documents.
