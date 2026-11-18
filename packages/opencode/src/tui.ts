import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
  createTuiPlugin,
  createValueViewer,
} from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

const plugin = createTuiPlugin(host, async (api) =>
  createValueViewer(api, await import("@opentui/core")),
) satisfies TuiPluginModule;

export default plugin;
