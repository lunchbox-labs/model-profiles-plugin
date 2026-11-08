# State machines

This document describes the state Model Profiles keeps across hooks, events and reloads. Update it in the same PR as any change to these states, their triggers or their exits, following the [state machine conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/state-machines.md), and cover each transition you add or change in `tests/`. Known bugs belong in issues, not here.

The server plugin's factory runs once per instance load, so closure state is rebuilt on every reload. Module-level state and files in the state directory survive reloads; files are also shared with other OpenCode processes.

## Fallback and reload controller

The server plugin in `src/server.ts` keeps `applied`, what its config hook applied (assignments, `configuredModel`, `configuredProviders`), and passes a getter for it to `createFallbacks`, which keeps per-instance closure state:

- `checkedOnce`: whether the first-event availability check was scheduled.
- `lastAvailable`: the last provider and model set this instance saw.
- `reloadWanted`: the applied refs no longer match availability.
- `reloading`: a reload attempt is in flight.
- `sessionModels`: each session's model after the hook, for subagent fallback; entries are removed on `session.deleted`.

The module-level `reloadedFor` map (directory to availability key) records the availability of the last successful reload per directory, so the same availability never triggers a second reload in one process.

Transitions:

- The config hook sets `applied`. If resolution throws, nothing is applied, `modelRef` is stripped and a notice is published.
- The first event of any type sets `checkedOnce` and schedules `check()`. Every `chat.message` also runs `check()` through `checkMessage`, so the two can run at the same time.
- `check()` reads `config.providers`, saves availability and sets `reloadWanted` when `assignmentsAreStale` reports a mismatch and `reloadedFor` does not already hold the current availability key. A provider error returns early and changes nothing. `check()` never clears `reloadWanted`.
- `session.idle` calls `scheduleReload`, which does nothing unless `reloadWanted` is set and no attempt is in flight. Only `session.idle` schedules a reload.
- `reloadWhenIdle` gives up for this attempt, leaving `reloadWanted` set, if `session.status` or `pty.list` errors, a session is not idle or a terminal is open. Otherwise it disposes the instance; on success it clears `reloadWanted` and records `reloadedFor`, and on a dispose error `reloadWanted` stays set.
- A successful dispose ends this closure. The host builds a new instance, whose config hook reads the saved availability.

```mermaid
stateDiagram-v2
    [*] --> Configured: factory and config hook
    Configured --> Checking: first event or chat.message
    Consistent --> Checking: chat.message
    Checking --> Configured: providers error, nothing changes
    Checking --> Consistent: refs match availability
    Checking --> Consistent: stale, but already reloaded for this availability
    Checking --> ReloadWanted: stale
    ReloadWanted --> ReloadWanted: chat.message or providers error
    ReloadWanted --> Reloading: session.idle, no attempt in flight
    Reloading --> ReloadWanted: session busy, terminal open, status or pty error, dispose error
    Reloading --> Disposed: dispose ok, reloadedFor recorded
    Disposed --> [*]: new instance runs the factory
```

## Availability cache

`src/fallback.ts` keeps availability in memory (`availability`, keyed by directory) and in `<state>/model-profiles/available/<hash of directory>.json`.

- `knownAvailableModels` reads memory first. When memory is empty, any config hook loads a valid file into memory, else it returns unknown, in which case every ref is applied.
- `rememberAvailableModels` runs on every successful check and always replaces memory. It writes the file through a temporary file and rename when memory was empty, the availability key changed or the ref-model set grew. Write errors are ignored.
- Memory always wins within a process. Between processes the file is last writer wins, and a process does not reread a file another process wrote once its memory is filled.

```mermaid
stateDiagram-v2
    [*] --> Unknown: no memory and no valid file
    [*] --> FromFile: config hook loads a valid file
    Unknown --> FromFile: a later config hook finds a valid file
    Unknown --> Known: check() succeeds
    FromFile --> Known: check() succeeds
    Known --> Known: check() replaces memory, file rewritten if the key changed or ref models grew
```

## Ref-model registry

`refModels` in `src/fallback.ts` holds every model the config hook resolved a ref to, whether or not the ref was applied. Each successful check adds the current assignments' models, and it is saved with availability and loaded from the file only when memory has none. In memory it only grows; the file holds whatever the last writing process saved. `checkMessage` reroutes a prompt off a model in this set when the model is unavailable and OpenCode took it from the agent or session.

## Profile selection

On every config hook, `resolveModelProfiles` in `src/apply.ts` reads `OPENCODE_MODEL_PROFILE` through `processProfile` and the saved selection through `readSavedSelection`, and `selectProfile` in `src/resolution.ts` picks the variable, then the saved selection, then `defaultProfile`, else no profile (defaults only). Unknown profiles are skipped with a notice. Each ref then resolves from the selected profile, then the defaults.

The saved selection is `<state>/model-profiles/worktrees/<hash of worktree>.json`. Only the TUI writes it: `saveSelection` through a temporary file and rename, and `clearSelection` for "Follow defaultProfile", which the dialog offers only when `defaultProfile` is set and a choice is saved. The server config hook and the TUI dialog read it. Reading an invalid or unreadable file adds a notice. A saved choice stays pending until the next instance load, whichever reload causes it.

```mermaid
stateDiagram-v2
    [*] --> Absent
    Absent --> Saved: pick a profile or Defaults only
    Saved --> Saved: pick again
    Saved --> Absent: Follow defaultProfile, when defaultProfile is set
    Absent --> Invalid: file corrupted outside the plugin
    Saved --> Invalid: file corrupted outside the plugin
    Invalid --> Saved: pick
    Saved --> Unreadable: permission or read error
    Unreadable --> Saved: pick, when writable
```

## TUI notices and provider poll

`registerModelConfig` in `src/tui.ts`:

- `readApplied` chains reads through `reading` so they never overlap. Each successful read replaces `shownNotices` with the current notices and returns the ones the previous successful read did not have; a failed read leaves `shownNotices` as it was. `announceFallbacks` and a pick's reload toast those new notices. Opening `/model-config` also reads, so notices it shows count as shown and are not toasted later. A notice that goes away and comes back is new again.
- The TUI words its unavailable-model notices the same way as the server's, so a notice the server reports after its own reload is not toasted twice.
- `providerTimer` polls `api.state.provider` every 500 ms until the list is non-empty, then announces, or stops after 60 ticks without announcing.
- `announceFallbacks` runs at startup, from the poll, on `server.instance.disposed` for this directory while `reloadsInFlight` is zero (including the server's own fallback reload), and on `global.disposed`.

```mermaid
stateDiagram-v2
    [*] --> Polling: register, announce report notices
    Polling --> Polling: tick with no providers, or a dispose event announces
    Polling --> Watching: providers loaded, announce
    Polling --> Watching: 60 ticks, stop without announcing
    Watching --> Watching: global disposed, or instance disposed with no own reload in flight, announce
    Polling --> [*]: lifecycle dispose
    Watching --> [*]: lifecycle dispose
```

## /model-config dialog and pick

In `src/tui.ts`, a notice row toasts its full text and keeps the dialog open, and a ref row does nothing. A profile, Defaults only or Follow defaultProfile row closes the dialog and runs `choose`:

- `choose` saves or clears the selection, toasting and stopping on an error. With `OPENCODE_MODEL_PROFILE` set it toasts that the variable still applies to this process and stops. Otherwise it calls `reload`, and toasts that the choice applies on the next reload if `reload` throws.
- `reload` toasts and stops if `session.status` errors or any session is busy. Otherwise it increments `reloadsInFlight`, disposes the instance and decrements it. On a dispose error it toasts a warning. After a successful dispose it reads the report again and toasts the profile in use with any new notices, or "Saved" when no report comes back. It does not check terminals.

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Closed: open without a report, warning toast
    Closed --> Open: open with a report
    Open --> Open: notice row toasts, ref row does nothing
    Open --> Closed: dismissed
    Open --> Saving: profile, Defaults only or Follow defaultProfile
    Saving --> Closed: save error or OPENCODE_MODEL_PROFILE set, toast
    Saving --> StatusCheck: saved, OPENCODE_MODEL_PROFILE unset
    StatusCheck --> Closed: status error or busy session, toast
    StatusCheck --> Disposing: all sessions idle
    Disposing --> Closed: dispose error, toast
    Disposing --> Closed: ok, "Using" or "Saved" toast
```

## Event ordering and error containment

- The server `event` hook is synchronous. The first check and every reload attempt are deferred with `setTimeout(0)`, so they run after the event that triggered them, and each ends in `.catch`.
- The first-event check and a `chat.message` check can overlap; both only set `reloadWanted` and replace memory, so the order does not matter.
- `chat.message` swallows any throw from `check()` and `parentModel()`, so no hook or event can fail the host.
