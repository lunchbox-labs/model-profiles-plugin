import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui";
import type { ModelProfilesReport } from "./report.ts";
import { processProfileVariable } from "./selection.ts";

export function profileLabel(profile: string | null): string {
  return profile ?? "Defaults only";
}

function modelLabel(ref: ModelProfilesReport["refs"][number]): string {
  if (ref.model === undefined) {
    return "not defined, OpenCode's model";
  }
  return ref.variant === undefined
    ? ref.model
    : `${ref.model} (${ref.variant})`;
}

export function modelConfigOptions(
  report: ModelProfilesReport,
  profiles: string[],
): TuiDialogSelectOption<string>[] {
  const profileCategory =
    report.environmentProfile === undefined
      ? "Profile for this worktree"
      : `Profile for this worktree (${processProfileVariable}=${report.environmentProfile} overrides it)`;
  const choices: (string | null)[] = [null, ...profiles];
  return [
    ...choices.map((profile) => ({
      title: profileLabel(profile),
      value: profile === null ? "defaults" : `profile:${profile}`,
      category: profileCategory,
      ...(profile === report.profile ? { footer: "current" } : {}),
      description:
        profile === null ? "Use only the defaults in models.jsonc" : undefined,
    })),
    ...report.refs.map((ref) => ({
      title: `${ref.ref} → ${modelLabel(ref)}`,
      value: `ref:${ref.ref}`,
      category: "Model refs",
      description:
        ref.agents.length === 0 ? "No agents" : ref.agents.join(", "),
      footer: ref.source === "unresolved" ? "fallback" : ref.source,
    })),
    ...report.notices.map((notice, index) => ({
      title: notice,
      value: `notice:${index}`,
      category: "Fallbacks",
    })),
  ];
}

export function selectedProfile(value: string): string | null | undefined {
  if (value === "defaults") {
    return null;
  }
  return value.startsWith("profile:")
    ? value.slice("profile:".length)
    : undefined;
}
