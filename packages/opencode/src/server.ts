import type { PluginModule } from "@opencode-ai/plugin";
import { createServerPlugin } from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

const plugin = createServerPlugin(host) satisfies PluginModule;

export default plugin;
