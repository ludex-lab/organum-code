import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const GRAPHIFY_LOADOUTS = ["bare", "graphify"] as const;
export type GraphifyLoadout = (typeof GRAPHIFY_LOADOUTS)[number];
export const GRAPHIFY_PROBLEM_TYPE = "discovery/navigation" as const;
export const GRAPHIFY_READ_ONLY_TOOLS = [
  "graphify__query_graph",
  "graphify__get_node",
  "graphify__get_neighbors",
  "graphify__get_community",
  "graphify__god_nodes",
  "graphify__graph_stats",
  "graphify__shortest_path",
  "graphify__list_prs",
  "graphify__get_pr_impact",
  "graphify__triage_prs",
] as const;

export interface GraphifyArtifactPin {
  packageVersion: string;
  installSpecifier: string;
  artifactPath: string;
  executablePath: string;
  sha256: string;
}

export interface GraphifyLoadoutConfig {
  loadout: GraphifyLoadout;
  problemType: typeof GRAPHIFY_PROBLEM_TYPE;
  mcpServers: readonly [] | readonly [{
    name: "graphify";
    command: string;
    args: readonly string[];
    env: readonly [];
  }];
}

export function buildGraphifyLoadoutConfig(
  loadout: GraphifyLoadout,
  pin?: GraphifyArtifactPin,
): GraphifyLoadoutConfig {
  if (!GRAPHIFY_LOADOUTS.includes(loadout)) {
    throw new Error(`Unknown Graphify loadout: ${loadout}`);
  }
  if (loadout === "bare") {
    return { loadout, problemType: GRAPHIFY_PROBLEM_TYPE, mcpServers: [] };
  }
  if (pin === undefined || pin.packageVersion.trim() === "" ||
      pin.installSpecifier !== `graphifyy[mcp]==${pin.packageVersion}` ||
      !/^[0-9a-f]{64}$/.test(pin.sha256) || pin.artifactPath.trim() === "" ||
      !isAbsolute(pin.executablePath)) {
    throw new Error("Graphify loadout requires an exact package and artifact pin");
  }
  return {
    loadout,
    problemType: GRAPHIFY_PROBLEM_TYPE,
    mcpServers: [{
      name: "graphify",
      command: pin.executablePath,
      // The Graphify MCP server exposes graph queries only; its graph_path is
      // positional and the server has no write-capable operation or read-only flag.
      args: [pin.artifactPath],
      env: [],
    }],
  };
}

export async function verifyGraphifyArtifact(pin: GraphifyArtifactPin): Promise<void> {
  const digest = createHash("sha256").update(await readFile(pin.artifactPath)).digest("hex");
  if (digest !== pin.sha256) {
    throw new Error(`Graphify artifact hash mismatch: expected ${pin.sha256}, got ${digest}`);
  }
}
