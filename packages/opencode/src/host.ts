import type { Host } from "@lunchbox-labs/model-profiles-core";
import { fileURLToPath } from "node:url";

/** OpenCode 1.19: its directories, variables and built-in agents. */
export const host: Host = {
  name: "OpenCode",
  packageName: "@lunchbox-labs/opencode-model-profiles",
  packageRoot: fileURLToPath(new URL("../", import.meta.url)),
  configFile: "opencode.jsonc",
  directoryName: "opencode",
  variables: {
    profile: "OPENCODE_MODEL_PROFILE",
    configDirectory: "OPENCODE_CONFIG_DIR",
    modelsPath: "OPENCODE_MODELS_PATH",
    testHome: "OPENCODE_TEST_HOME",
  },
  modelsUrl: {
    variable: "OPENCODE_MODELS_URL",
    defaultUrl: "https://models.opencode.ai",
  },
  builtInAgents: [
    "build",
    "plan",
    "general",
    "explore",
    "compaction",
    "title",
    "summary",
  ],
  loaderVariables: [],
};
