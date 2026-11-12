import { type Host, isRecord } from "@lunchbox-labs/model-profiles-core";
import { fileURLToPath } from "node:url";

/**
 * Kilo's organization selector, in the order its model catalog reads it: KILO_ORG_ID, the account of a Kilo OAuth
 * login, the provider's `kilocodeOrganizationId` option, then the organization in its `baseURL`. It selects which
 * models Kilo offers and is not a secret.
 */
export function kiloOrganization(
  config: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  auth: unknown,
): string | undefined {
  const login = isRecord(auth) ? auth.kilo : undefined;
  const account =
    isRecord(login) && login.type === "oauth" ? login.accountId : undefined;
  const provider = isRecord(config.provider) ? config.provider.kilo : undefined;
  const options =
    isRecord(provider) && isRecord(provider.options) ? provider.options : {};
  const explicit = [
    environment.KILO_ORG_ID,
    account,
    options.kilocodeOrganizationId,
  ].find((value): value is string => typeof value === "string" && value !== "");
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof options.baseURL !== "string") {
    return undefined;
  }
  return URL.parse(options.baseURL)
    ?.pathname.match(/\/api\/organizations\/([^/]+)/)
    ?.at(1);
}

/** Kilo CLI 7.8: its directories, variables and built-in agents, and what it does differently from OpenCode. */
export const host: Host = {
  name: "Kilo",
  packageName: "@lunchbox-labs/kilo-model-profiles",
  packageRoot: fileURLToPath(new URL("../", import.meta.url)),
  configFile: "kilo.jsonc",
  directoryName: "kilo",
  variables: {
    profile: "KILO_MODEL_PROFILE",
    configDirectory: "KILO_CONFIG_DIR",
    modelsPath: "KILO_MODELS_PATH",
    modelsUrl: "KILO_MODELS_URL",
    testHome: "KILO_TEST_HOME",
  },
  builtInAgents: [
    "code",
    "build",
    "debug",
    "ask",
    "orchestrator",
    "scout",
    "plan",
    "general",
    "explore",
    "compaction",
    "title",
    "summary",
  ],
  // Kilo renamed OpenCode's build agent to code and still reads build as code.
  renamedAgents: { build: "code" },
  experimentalAgents: {
    scout: ["KILO_EXPERIMENTAL", "KILO_EXPERIMENTAL_SCOUT"],
  },
  loaderVariables: [
    "APERTIS_API_KEY",
    "APERTIS_BASE_URL",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_RESOURCE_NAME",
    "KILO_API_KEY",
    "KILO_ORG_ID",
  ],
  stateInDataDirectory: true,
  // The organization decides which Kilo models connect, so each one keeps its own availability.
  providerSetup: ({ config, environment, auth }) => ({
    kiloOrganization: kiloOrganization(config, environment, auth),
  }),
};
