import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui";
import type { ModelProfilesReport } from "./report.ts";
import { type ProfileSource, unavailableModelNotice } from "./resolution.ts";
import { type SavedProfile, processProfileVariable } from "./selection.ts";

export function profileLabel(profile: string | null): string {
  return profile ?? "Defaults only";
}

type RefResolution = ModelProfilesReport["refs"][number];

function modelLabel(ref: RefResolution): string {
  if (ref.model === undefined) {
    return "not defined, OpenCode's model";
  }
  const details = [
    ...(ref.variant === undefined ? [] : [ref.variant]),
    ...(Array.isArray(ref.settings) ? ref.settings : []),
  ];
  const model =
    details.length === 0 ? ref.model : `${ref.model} (${details.join(", ")})`;
  return ref.unavailable === true
    ? `${model}, unavailable, OpenCode's model`
    : model;
}

export interface ConnectedProvider {
  id: string;
  models: Record<string, unknown>;
}

/**
 * The server's config hook runs before providers load, so the TUI checks resolved models against them until
 * the server has marked a ref unavailable itself. With no provider list (not loaded yet) nothing is reported.
 */
export function unavailableModelNotices(
  refs: readonly RefResolution[],
  providers: readonly ConnectedProvider[],
): string[] {
  if (providers.length === 0) {
    return [];
  }
  return refs.flatMap((ref) => {
    if (
      ref.model === undefined ||
      ref.unavailable === true ||
      ref.agents.length === 0
    ) {
      return [];
    }
    const separator = ref.model.indexOf("/");
    const providerId = ref.model.slice(0, separator);
    const modelId = ref.model.slice(separator + 1);
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider !== undefined && Object.hasOwn(provider.models, modelId)) {
      return [];
    }
    return [
      unavailableModelNotice(
        ref.ref,
        ref.model,
        ref.agents,
        provider !== undefined,
      ),
    ];
  });
}

const sourceLabels: Record<ProfileSource, string> = {
  environment: processProfileVariable,
  saved: "saved",
  defaultProfile: "defaultProfile",
  none: "no profile chosen",
};

export interface ModelConfigViewInput {
  report: ModelProfilesReport;
  /** Profiles in models.jsonc now, which may be newer than the report. */
  profiles: string[];
  /** The worktree's saved choice now; it differs from the report while a pick waits for a reload. */
  savedProfile: SavedProfile;
  defaultProfile: string | undefined;
  notices: string[];
}

export type ModelConfigChoice =
  { kind: "save"; profile: string | null } | { kind: "followDefaultProfile" };

const followDefaultProfileValue = "follow-default-profile";

export function modelConfigOptions(
  input: ModelConfigViewInput,
): TuiDialogSelectOption<string>[] {
  const { report, savedProfile, defaultProfile } = input;
  const profileCategory =
    report.environmentProfile === undefined
      ? "Profile for this worktree"
      : `Profile for this worktree (${processProfileVariable}=${report.environmentProfile} overrides it)`;
  const pending =
    savedProfile !== undefined &&
    (report.profileSource !== "saved" || savedProfile !== report.profile);
  const footer = (profile: string | null) => {
    const marks = [
      ...(profile === report.profile
        ? [`current, ${sourceLabels[report.profileSource]}`]
        : []),
      ...(pending && profile === savedProfile
        ? [
            report.environmentProfile === undefined
              ? "saved, applies on reload"
              : "saved for later processes",
          ]
        : []),
    ];
    return marks.length === 0 ? {} : { footer: marks.join("; ") };
  };
  const choices: (string | null)[] = [null, ...input.profiles];
  return [
    ...(defaultProfile === undefined || savedProfile === undefined
      ? []
      : [
          {
            title: `Follow defaultProfile (${defaultProfile})`,
            value: followDefaultProfileValue,
            category: profileCategory,
            description: "Forget the saved choice for this worktree",
          },
        ]),
    ...choices.map((profile) => ({
      title: profileLabel(profile),
      value: profile === null ? "defaults" : `profile:${profile}`,
      category: profileCategory,
      ...footer(profile),
      description:
        profile === null ? "Use only the defaults in models.jsonc" : undefined,
    })),
    ...report.refs.map((ref) => ({
      title: `${ref.ref} → ${modelLabel(ref)}`,
      value: `ref:${ref.ref}`,
      category: "Model refs",
      description:
        ref.agents.length === 0 ? "No agents" : ref.agents.join(", "),
      footer:
        ref.source === "unresolved" || ref.unavailable === true
          ? "fallback"
          : ref.source,
    })),
    ...input.notices.map((notice, index) => ({
      title: notice,
      value: `notice:${index}`,
      category: "Fallbacks",
    })),
  ];
}

/** Fallback rows can be cut off in the list, so choosing one shows its full text. */
export function selectedNotice(
  value: string,
  notices: readonly string[],
): string | undefined {
  return value.startsWith("notice:")
    ? notices[Number(value.slice("notice:".length))]
    : undefined;
}

export function selectedChoice(value: string): ModelConfigChoice | undefined {
  if (value === followDefaultProfileValue) {
    return { kind: "followDefaultProfile" };
  }
  if (value === "defaults") {
    return { kind: "save", profile: null };
  }
  return value.startsWith("profile:")
    ? { kind: "save", profile: value.slice("profile:".length) }
    : undefined;
}

/** One toast line per problem would bury the message, so a toast names the first and points to the dialog. */
export function fallbackToastLines(notices: readonly string[]): string[] {
  const more = notices.length - 1;
  return more <= 0
    ? [...notices]
    : [
        ...notices.slice(0, 1),
        `${more} more ${more === 1 ? "problem" : "problems"}; see /model-config.`,
      ];
}
