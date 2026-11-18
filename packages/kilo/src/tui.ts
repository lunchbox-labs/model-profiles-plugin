import type { TuiPlugin } from "@kilocode/plugin/tui";
import {
  createTuiPlugin,
  createValueViewer,
} from "@lunchbox-labs/model-profiles-core";
import { host } from "./host.ts";

// The core is typed against OpenCode's TUI API. Kilo's has the same shape, with a few fields typed more loosely.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the same API under Kilo's names
const plugin = createTuiPlugin(host, async (api) =>
  createValueViewer(
    api,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Kilo supplies the same renderer API with nominally different types.
    (await import("@opentui/core")) as unknown as Parameters<
      typeof createValueViewer
    >[1],
  ),
) as unknown as {
  id: string;
  tui: TuiPlugin;
};

export default plugin;
