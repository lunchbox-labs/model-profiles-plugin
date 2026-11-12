import type { PluginModule } from "@opencode-ai/plugin";
import { createServerPlugin } from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

const plugin: PluginModule = createServerPlugin(host);

export default plugin;
