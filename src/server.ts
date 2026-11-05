import type { Plugin, PluginModule } from "@opencode-ai/plugin";

const ModelProfilesServer: Plugin = () => Promise.resolve({});

export default {
  id: "model-profiles",
  server: ModelProfilesServer,
} satisfies PluginModule;
