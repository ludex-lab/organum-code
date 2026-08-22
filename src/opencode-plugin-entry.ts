import {
  createOrganumCodePlugin,
  type OpenCodePluginInput,
  type PluginHooks,
} from "./opencode-plugin.js";

// OpenCode instantiates every function exported by a plugin module. Keep the
// production bundle surface to exactly one factory even though the underlying
// factory remains exported from its source module for focused tests.
export const OrganumCodePlugin = async (
  input: OpenCodePluginInput,
): Promise<PluginHooks> => await createOrganumCodePlugin(input);
