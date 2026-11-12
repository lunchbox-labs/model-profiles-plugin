import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Host } from "./host.ts";
import { isRecord } from "./models-file.ts";
import type { ProfileSource, RefResolution } from "./resolution.ts";

const reportKey = "modelProfilesReport";

/** What the server applied, published in its own plugin entry so the TUI can read it through /config. */
export interface ModelProfilesReport {
  version: 1;
  configFile: string;
  selectionFile: string;
  worktree: string;
  profiles: string[];
  profile: string | null;
  profileSource: ProfileSource;
  environmentProfile?: string;
  refs: RefResolution[];
  notices: string[];
}

function isOwnSpecifier(host: Host, specifier: unknown): boolean {
  if (typeof specifier !== "string") {
    return false;
  }
  const { packageName } = host;
  if (specifier === packageName || specifier.startsWith(`${packageName}@`)) {
    return true;
  }
  if (!specifier.startsWith("file:")) {
    return false;
  }
  try {
    const target = path.resolve(fileURLToPath(specifier));
    const packageRoot = path.resolve(host.packageRoot);
    return target === packageRoot || target.startsWith(packageRoot + path.sep);
  } catch {
    return false;
  }
}

export function publishReport(
  host: Host,
  config: Record<string, unknown>,
  options: unknown,
  report: ModelProfilesReport,
): boolean {
  if (!Array.isArray(config.plugin)) {
    return false;
  }
  const plugins: unknown[] = [...(config.plugin as unknown[])];
  const index = plugins.findIndex((entry) =>
    Array.isArray(entry)
      ? entry[1] === options || isOwnSpecifier(host, entry[0])
      : isOwnSpecifier(host, entry),
  );
  if (index < 0) {
    return false;
  }
  const entry: unknown = plugins[index];
  const specifier: unknown = Array.isArray(entry) ? entry[0] : entry;
  const entryOptions: unknown = Array.isArray(entry) ? entry[1] : undefined;
  plugins[index] = [
    specifier,
    {
      ...(isRecord(entryOptions) ? entryOptions : {}),
      [reportKey]: JSON.parse(JSON.stringify(report)) as unknown,
    },
  ];
  config.plugin = plugins;
  return true;
}

function isReport(value: unknown): value is ModelProfilesReport {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.configFile === "string" &&
    typeof value.selectionFile === "string" &&
    typeof value.worktree === "string" &&
    (value.profile === null || typeof value.profile === "string") &&
    Array.isArray(value.profiles) &&
    Array.isArray(value.refs) &&
    Array.isArray(value.notices)
  );
}

export function readReport(config: unknown): ModelProfilesReport | undefined {
  if (!isRecord(config) || !Array.isArray(config.plugin)) {
    return undefined;
  }
  for (const entry of config.plugin as unknown[]) {
    const report: unknown =
      Array.isArray(entry) && isRecord(entry[1])
        ? entry[1][reportKey]
        : undefined;
    if (isReport(report)) {
      return report;
    }
  }
  return undefined;
}
