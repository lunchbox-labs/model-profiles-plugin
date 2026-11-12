# Profiles

## Pick a profile

Run `/model-config` (**Model config** in the command palette). It lists **Defaults only** and each profile, with the current one marked along with where it came from, then every ref with the model it resolves to and the agents that use it, then any fallbacks.

Picking a profile saves it for the current worktree in the host's state directory and reloads the project so it applies at once. If a session is busy or a terminal is open (a reload would end it), the choice is saved, marked **saved, applies on reload**, and the project reloads once no session is busy and every terminal is closed, unless another reload applies it first. When `defaultProfile` is set and a choice is saved, **Follow defaultProfile** forgets the saved choice.

`OPENCODE_MODEL_PROFILE=<profile>` (on Kilo, `KILO_MODEL_PROFILE`) selects a profile for one process and overrides the saved choice. `/model-config` shows when it is set; a pick made then is saved for later processes.

OpenCode and Kilo keep their choices apart, each in its own state directory (see [Host differences](Usage#host-differences)), so a pick in one host never changes the other.

## Precedence

The profile variable, then the saved worktree choice, then `defaultProfile`, then defaults only. A profile that `models.jsonc` does not define is skipped in favour of the next.
