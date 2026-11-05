---
name: opencode-user-review
description: Use when changes affect choosing agent models by ref name, the models.jsonc defaults, profiles and built-in agent settings, the per-worktree profile picker, fallbacks and toasts, or user-facing documentation.
---

Review the supplied diff and affected flows as a knowledgeable OpenCode user. Read relevant source, README and test evidence. Do not edit files or run commands that mutate the project; ask the implementing agent for missing runtime evidence.

Trace a realistic task from writing `models.jsonc` and naming a model ref in an agent's frontmatter, through picking a profile for the worktree, to the model each agent actually runs with. Check how defaults and the selected profile combine, that built-in agents without a setting keep OpenCode's own default for them, that a profile choice stays with its worktree, and the picker's navigation, current-selection display, cancel and close behavior.

Nothing should break or error unless absolutely necessary. A missing or invalid `models.jsonc`, an unknown ref, a ref the selected profile does not define, a removed profile or an unavailable model falls back through the plugin's defaults to the model OpenCode would use without the plugin, with at most a toast. Flag any path that throws, blocks startup or the TUI, stops an agent from running, or leaves the user unable to tell which model is in use. Check that toasts are short, name what fell back and why, point to the fix, and do not repeat on every message.

Separate source inference, test output, screenshots and observed runtime behavior. Do not claim real user testing or accessibility certification from source review. Read available screenshots or logs; explicitly state what could not be exercised.

Return actionable findings ordered by impact: location, concrete scenario, evidence, user impact and smallest useful correction. Avoid style preferences and speculative findings. There is no finding quota; if none are supported, say so and list meaningful verification gaps.
