import type { ProviderProfile, Role } from "./provider-profile.js";
import {
  MTI_REFLEX_OPENCODE_TOOL_NAME,
  validateMtiReflexMcpHttpServer,
  type MtiReflexMcpHttpServer,
} from "./mti-reflex-mcp.js";

type PermissionAction = "allow" | "ask" | "deny";
type PatternPermissions = Record<string, PermissionAction>;

interface AgentConfig {
  description: string;
  mode: "primary";
  model: string;
  prompt: string;
  permission: Record<string, PermissionAction | PatternPermissions>;
  tools?: Record<string, boolean>;
}

export interface OpenCodeConfig {
  $schema: string;
  model: string;
  small_model: string;
  default_agent: string;
  enabled_providers: string[];
  autoupdate: false;
  share: "disabled";
  permission: Record<string, PermissionAction | PatternPermissions>;
  tools?: Record<string, boolean>;
  mcp?: Record<string, {
    type: "remote";
    url: string;
    enabled: true;
    oauth: false;
    headers: Record<string, string>;
  }>;
  provider: Record<
    string,
    {
      npm: string;
      name: string;
      options: {
        apiKey: string;
        baseURL: string;
      };
      models: Record<string, { name: string }>;
    }
  >;
  agent: Record<string, AgentConfig>;
}

const SAFE_READ_BASH: PatternPermissions = {
  "organum *": "deny",
  "*/organum *": "deny",
  "*organum *": "deny",
  "git status": "allow",
  "git status *": "allow",
  "git diff": "allow",
  "git diff *": "allow",
  "git log": "allow",
  "git log *": "allow",
  "git show *": "allow",
  "rg *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "pytest": "allow",
  "pytest *": "allow",
  "python -m pytest": "allow",
  "python -m pytest *": "allow",
  "python3 -m pytest": "allow",
  "python3 -m pytest *": "allow",
  "PYTHONPATH=* python -m pytest": "allow",
  "PYTHONPATH=* python -m pytest *": "allow",
  "PYTHONPATH=* python3 -m pytest": "allow",
  "PYTHONPATH=* python3 -m pytest *": "allow",
  "rm": "deny",
  "rm *": "deny",
  "sudo *": "deny",
  "git clean*": "deny",
  "git push*": "deny",
  "git reset --hard*": "deny",
};

const READ_ONLY_BASH: PatternPermissions = {
  // Read-only agents are fail-closed: an unknown command must never deadlock a
  // headless session waiting for interactive approval.
  "*": "deny",
  ...SAFE_READ_BASH,
};

const IMPLEMENTER_BASH: PatternPermissions = {
  "*": "ask",
  ...SAFE_READ_BASH,
  "npm test": "allow",
  "npm test *": "allow",
  "npm run test": "allow",
  "npm run test *": "allow",
  "npm run check": "allow",
  "npm run check *": "allow",
  "npm run build": "allow",
  "npm run build *": "allow",
};

const ROLE_PROMPTS: Record<Role, string> = {
  implementer:
    "You are the implementation cell for this coding session. Inspect before editing, keep changes scoped to the current worktree, verify proportionally, and report changed files, evidence, and unresolved risks. Use organum_handoff to durably publish the scoped team result before going idle; this coordination handoff is not an external release. Do not publish or mutate other external systems without explicit approval.",
  reviewer:
    "You are an independent code reviewer. Look for correctness, security, regressions, missing tests, and contract violations. Cite concrete files and evidence. Do not modify files; publish the grounded review with organum_handoff before going idle.",
  critic:
    "You are an independent cross-component code critic. Hunt for seam failures, invariant violations, regressions, and unsupported claims. Reproduce before asserting, cite concrete files and evidence, and label unreproduced concerns as suspicions. Batch reads and keep the review bounded. After one successful declared reproduction command and enough concrete evidence, make organum_handoff your next non-read tool call. Do not modify files.",
  researcher:
    "You are a coding researcher. Gather evidence, compare viable approaches, and make implementation-ready recommendations. Distinguish verified facts from inference. Do not modify files; publish the scoped team result with organum_handoff before going idle, but do not mutate other external systems.",
};

const COORDINATION_TOOL_PERMISSIONS = {
  organum_publish: "allow" as const,
  organum_handoff: "allow" as const,
};

const SESSION_LOCAL_TOOL_PERMISSIONS = {
  // OpenCode stores todos in the current session; this does not mutate the worktree.
  todowrite: "allow" as const,
};

function roleAgent(
  role: Role,
  model: string,
): AgentConfig {
  const common = {
    mode: "primary" as const,
    model,
    prompt: ROLE_PROMPTS[role],
  };

  if (role === "implementer") {
    return {
      ...common,
      description: "Implements and verifies scoped changes in the current worktree",
      permission: {
        ...COORDINATION_TOOL_PERMISSIONS,
        ...SESSION_LOCAL_TOOL_PERMISSIONS,
        edit: "allow",
        bash: IMPLEMENTER_BASH,
        task: "deny",
        external_directory: "deny",
        webfetch: "ask",
      },
    };
  }

  if (role === "reviewer" || role === "critic") {
    return {
      ...common,
      description: "Reviews code independently without modifying the worktree",
      permission: {
        ...COORDINATION_TOOL_PERMISSIONS,
        ...SESSION_LOCAL_TOOL_PERMISSIONS,
        edit: "deny",
        bash: READ_ONLY_BASH,
        task: "deny",
        skill: "deny",
        question: "deny",
        external_directory: "deny",
        webfetch: "deny",
      },
    };
  }

  return {
    ...common,
    description: "Researches coding decisions without modifying the worktree",
    permission: {
      ...COORDINATION_TOOL_PERMISSIONS,
      ...SESSION_LOCAL_TOOL_PERMISSIONS,
      edit: "deny",
      bash: READ_ONLY_BASH,
      task: "deny",
      external_directory: "deny",
      webfetch: "ask",
    },
  };
}

export function agentName(role: Role): string {
  return `organum-${role}`;
}

export function buildOpenCodeConfig(profile: ProviderProfile): OpenCodeConfig {
  const model = `${profile.providerID}/${profile.modelID}`;
  const agents = Object.fromEntries(
    (["implementer", "reviewer", "critic", "researcher"] as const).map((role) => [
      agentName(role),
      roleAgent(role, model),
    ]),
  );

  return {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    default_agent: agentName(profile.role),
    enabled_providers: [profile.providerID],
    autoupdate: false,
    share: "disabled",
    permission: {
      "*": "ask",
      ...COORDINATION_TOOL_PERMISSIONS,
      ...SESSION_LOCAL_TOOL_PERMISSIONS,
      read: "allow",
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      edit: "ask",
      bash: "ask",
      task: "deny",
      external_directory: "deny",
    },
    provider: {
      [profile.providerID]: {
        npm:
          profile.protocol === "responses"
            ? "@ai-sdk/openai"
            : "@ai-sdk/openai-compatible",
        name: profile.providerName,
        options: {
          baseURL: profile.baseURL,
          apiKey: `{env:${profile.apiKeyEnv}}`,
        },
        models: {
          [profile.modelID]: {
            name: profile.modelName,
          },
        },
      },
    },
    agent: agents,
  };
}

export function projectOpenCodeMtiReflexConfig(
  config: OpenCodeConfig,
  server: MtiReflexMcpHttpServer,
): OpenCodeConfig {
  const admitted = validateMtiReflexMcpHttpServer(server);
  const exactTools = {
    "*": false,
    [MTI_REFLEX_OPENCODE_TOOL_NAME]: true,
  };
  const exactPermission: Record<string, PermissionAction> = {
    "*": "deny",
    [MTI_REFLEX_OPENCODE_TOOL_NAME]: "allow",
  };
  return {
    ...config,
    permission: exactPermission,
    tools: exactTools,
    mcp: {
      [admitted.name]: {
        type: "remote",
        url: admitted.url,
        enabled: true,
        oauth: false,
        headers: Object.fromEntries(
          admitted.headers.map(({ name, value }) => [name, value]),
        ),
      },
    },
    agent: Object.fromEntries(
      Object.entries(config.agent).map(([name, agent]) => [
        name,
        {
          ...agent,
          permission: exactPermission,
          tools: exactTools,
        },
      ]),
    ),
  };
}
