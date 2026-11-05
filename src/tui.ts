import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const ModelProfilesTui: TuiPlugin = () => Promise.resolve();

export default {
  id: "model-profiles",
  tui: ModelProfilesTui,
} satisfies TuiPluginModule;
