import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createTuiPlugin } from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

const plugin: TuiPluginModule = createTuiPlugin(host);

export default plugin;
