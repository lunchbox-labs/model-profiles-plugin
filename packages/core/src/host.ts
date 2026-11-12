/**
 * What differs between the hosts that load the plugin: OpenCode and Kilo CLI, an OpenCode fork with the same plugin
 * API. Each host package passes its own profile to the core, which reads every host name, directory, variable and
 * agent name from it.
 */
export interface Host {
  /** The host's name in messages, such as "OpenCode". */
  readonly name: string;
  /** The host package's npm name; the server publishes its report in the `plugin` entry that names it. */
  readonly packageName: string;
  /** The host package's root directory, which a `file:` plugin entry may point at instead of the npm name. */
  readonly packageRoot: string;
  /** The host's main config file, named in messages, such as "opencode.jsonc". */
  readonly configFile: string;
  /** The folder the host keeps under each XDG base directory, such as "opencode". */
  readonly directoryName: string;
  readonly variables: {
    /** Selects a profile for one process, such as OPENCODE_MODEL_PROFILE. */
    readonly profile: string;
    /** The host's global config directory override, such as OPENCODE_CONFIG_DIR. */
    readonly configDirectory: string;
    /** Points the host at a models.dev catalog file instead of its cached copy, such as OPENCODE_MODELS_PATH. */
    readonly modelsPath: string;
    /** Replaces the home directory in the host's tests, such as OPENCODE_TEST_HOME; `~` in configFile follows it. */
    readonly testHome: string;
  };
  /**
   * Where the host downloads its models.dev catalog from: the variable that overrides the source, such as
   * OPENCODE_MODELS_URL, and the source it uses when that is unset or empty. The host caches the default source as
   * `models.json` and any other as `models-<sha1 of the URL>.json`.
   */
  readonly modelsUrl: {
    readonly variable: string;
    readonly defaultUrl: string;
  };
  /**
   * Set when the host drops line breaks from the home directory and the XDG base directories before using them,
   * so a stray one from a shell profile still names the same folder. Without it they are used as they are.
   */
  readonly trimsPathLineBreaks?: boolean;
  /** The host's built-in agents, which take refs from `builtins` in models.jsonc. */
  readonly builtInAgents: readonly string[];
  /**
   * Built-in agents the host renamed, old name to new name. The old name still works in `builtins` and in the
   * host config, and applies to the new agent unless the new name is set too.
   */
  readonly renamedAgents?: Readonly<Record<string, string>>;
  /**
   * Built-in agents the host enables only when one of these variables is "true" or "1". Without one, their
   * `builtins` entry is skipped with a notice instead of creating an agent the host does not run.
   */
  readonly experimentalAgents?: Readonly<Record<string, readonly string[]>>;
  /** Variables the host's own provider loaders read besides the catalog's lists, such as Bedrock's region. */
  readonly loaderVariables: readonly string[];
  /**
   * Set when the host uses `<data directory>/state` as its state directory when that folder is writable at startup
   * and XDG_STATE_HOME is unset. The host decides once per process, so the plugin does too.
   */
  readonly stateInDataDirectory?: boolean;
  /**
   * Non-secret, host-specific facts that decide which providers connect, added to the provider setup key. It gets
   * the parsed `auth.json` (undefined without one) and must never return a credential.
   */
  readonly providerSetup?: (input: {
    config: Record<string, unknown>;
    environment: NodeJS.ProcessEnv;
    auth: unknown;
  }) => Record<string, unknown>;
}
