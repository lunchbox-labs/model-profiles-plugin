import type { PluginModule } from "@kilocode/plugin";
import { createServerPlugin } from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

// The core is typed against OpenCode's plugin API. Kilo's has the same shape, but its SDK client classes are
// separate declarations, so TypeScript can't relate the two.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the same API under Kilo's names
const plugin = createServerPlugin(host) as unknown as PluginModule;

export default plugin;
