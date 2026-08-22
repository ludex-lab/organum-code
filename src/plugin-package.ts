import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GENERATED_FIRST_PARTY_PLUGIN_SOURCE } from "./generated/first-party-plugin.js";
import {
  FIRST_PARTY_PLUGIN_PROTOCOL,
  PLUGIN_PROBE_ENV,
} from "./plugin-protocol.js";

export const FIRST_PARTY_PLUGIN_FILENAME = "organum-code.js";
export { FIRST_PARTY_PLUGIN_PROTOCOL, PLUGIN_PROBE_ENV };

const IGNORE_CONTENT = [
  "node_modules",
  "package.json",
  "package-lock.json",
  "bun.lock",
  ".gitignore",
  "",
].join("\n");

function globalConfigDirectory(configDirectory: string): string {
  return join(configDirectory, "xdg-config", "opencode");
}

// This source is produced from the real runtime modules. OpenCode executes the
// resulting single file with its embedded Bun, without package installation.
export const FIRST_PARTY_PLUGIN_SOURCE = GENERATED_FIRST_PARTY_PLUGIN_SOURCE;

export async function packageFirstPartyPlugin(
  configDirectory: string,
): Promise<string> {
  const pluginDirectory = join(configDirectory, "plugins");
  const pluginPath = join(pluginDirectory, FIRST_PARTY_PLUGIN_FILENAME);
  const globalConfig = globalConfigDirectory(configDirectory);

  await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(join(configDirectory, "home"), { recursive: true, mode: 0o700 }),
    mkdir(join(configDirectory, "app-data"), { recursive: true, mode: 0o700 }),
    mkdir(join(configDirectory, "local-app-data"), {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(globalConfig, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(pluginPath, FIRST_PARTY_PLUGIN_SOURCE, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await Promise.all([
    writeFile(join(configDirectory, ".gitignore"), IGNORE_CONTENT, {
      encoding: "utf8",
      mode: 0o400,
      flag: "wx",
    }),
    writeFile(join(globalConfig, ".gitignore"), IGNORE_CONTENT, {
      encoding: "utf8",
      mode: 0o400,
      flag: "wx",
    }),
  ]);

  // OpenCode v1.18.3 checks directory writability before its background
  // @opencode-ai/plugin install. Sealing both discovered config directories
  // makes that path a no-op while the dependency-free JS plugin remains
  // directly importable.
  await chmod(pluginPath, 0o400);
  await chmod(pluginDirectory, 0o500);
  await chmod(globalConfig, 0o500);
  await chmod(configDirectory, 0o500);

  return pluginPath;
}

export async function unsealFirstPartyPlugin(
  configDirectory: string,
): Promise<void> {
  await Promise.allSettled([
    chmod(configDirectory, 0o700),
    chmod(join(configDirectory, "plugins"), 0o700),
    chmod(globalConfigDirectory(configDirectory), 0o700),
  ]);
}
