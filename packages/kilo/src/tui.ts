import type { TuiPluginModule } from "@kilocode/plugin/tui";
import { createTuiPlugin } from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

// The core is typed against OpenCode's TUI API. Kilo's has the same shape, with a few fields typed more loosely.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the same API under Kilo's names
const plugin = createTuiPlugin(host) as unknown as TuiPluginModule;

export default plugin;
