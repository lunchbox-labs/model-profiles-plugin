import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import {
  modelsFilePath,
  resolveModelProfiles,
  stripModelRefs,
} from "./apply.ts";
import { publishReport } from "./report.ts";
import {
  selectionFilePath,
  stateDirectory,
  worktreeRoot,
} from "./selection.ts";

const ModelProfilesServer: Plugin = (input, options) => {
  const worktree = worktreeRoot(input.worktree, input.directory);
  return Promise.resolve({
    config: async (config) => {
      const target = config as Record<string, unknown>;
      const configFile = modelsFilePath(options);
      try {
        publishReport(
          target,
          options,
          await resolveModelProfiles(target, { configFile, worktree }),
        );
      } catch (error) {
        try {
          stripModelRefs(target);
          publishReport(target, options, {
            version: 1,
            configFile,
            selectionFile: selectionFilePath(stateDirectory(), worktree),
            worktree,
            profiles: [],
            profile: null,
            profileSource: "none",
            refs: [],
            notices: [
              `Model refs were not applied (${error instanceof Error ? error.message : String(error)}); agents keep OpenCode's models.`,
            ],
          });
        } catch {
          // A failing config hook must never stop OpenCode; agents then keep OpenCode's models.
        }
      }
    },
  });
};

export default {
  id: "model-profiles",
  server: ModelProfilesServer,
} satisfies PluginModule;
