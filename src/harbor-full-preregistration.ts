import { createHash } from "node:crypto";

import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const sha256Ref = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const catalogTaskSchema = z
  .object({
    order: z.number().int().positive(),
    name: z.string().min(1),
    ref: sha256Ref,
  })
  .strict();

export const harborFullPreregistrationSchema = z
  .object({
    schema: z.literal(
      "organum-code/harbor-terminal-bench-preregistration/v2",
    ),
    status: z.literal("preregistered-awaiting-execution-gates"),
    created_at: z.string().min(1),
    amended_at: z.string().min(1).optional(),
    amendment: z
      .object({
        scope: z.literal("portable-offline-grok-distribution"),
        reason: z.string().min(1),
        provider_execution_performed: z.literal(false),
      })
      .strict()
      .optional(),
    purpose: z.string().min(1),
    dataset: z
      .object({
        id: z.string().min(1),
        release: z.string().min(1),
        ref: sha256Ref,
        registry_version_id: z.string().uuid(),
        task_count: z.number().int().positive(),
        catalog_sha256: sha256,
        tasks: z.array(catalogTaskSchema).min(1),
      })
      .strict(),
    selection: z
      .object({
        include_task_names: z.array(z.string().min(1)).min(1),
        order: z.literal("registry-order-repeated-by-attempt"),
        attempts: z.number().int().positive(),
        retries: z.literal(0),
        concurrency: z.literal(1),
        expected_trials: z.number().int().positive(),
      })
      .strict(),
    adapter: z
      .object({
        import_path: z.string().min(1),
        harbor_version: z.string().min(1),
        backend: z.string().min(1),
        backend_version: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        broker_max_requests_per_trial: z.number().int().positive(),
        broker_request_timeout_ms: z.number().int().positive(),
        broker_transport: z.string().min(1),
        distribution_manifest: z.literal(
          "integrations/harbor/grok-artifacts-v1.json",
        ),
        distribution_manifest_sha256: sha256,
        agent_setup_network: z.literal("none"),
        artifacts: z
          .array(
            z
              .object({
                platform: z.enum(["linux-aarch64", "linux-x86_64"]),
                sha256,
                bytes: z.number().int().positive(),
              })
              .strict(),
          )
          .length(2),
        upstream_key_enters_container: z.literal(false),
      })
      .strict(),
    official_protocol: z
      .object({
        leaderboard_attempts: z.literal(5),
        timeout_multiplier: z.literal(1),
        agent_timeout_multiplier: z.null(),
        verifier_timeout_multiplier: z.null(),
        agent_setup_timeout_multiplier: z.null(),
        environment_build_timeout_multiplier: z.null(),
        task_resources: z.literal("unmodified"),
        verifier_disabled: z.literal(false),
        environment_type: z.literal("docker"),
        cpu_enforcement_policy: z.literal("auto"),
        memory_enforcement_policy: z.literal("auto"),
        resource_overrides: z.null(),
        operator_input: z.literal("none"),
      })
      .strict(),
    operational_budget: z
      .object({
        execution_authorization: z.literal("separate-explicit-jj-go"),
        max_concurrent_task_containers: z.literal(1),
        max_upstream_requests: z.number().int().positive(),
        hard_token_cap: z.null(),
        sample_based_token_projection: z
          .object({
            basis: z.string().min(1),
            input_tokens: z.number().int().nonnegative(),
            cache_read_tokens: z.number().int().nonnegative(),
            output_tokens: z.number().int().nonnegative(),
            warning: z.string().min(1),
          })
          .strict(),
        sample_based_wall_hours: z.number().nonnegative(),
        campaign_wall_clock_soft_budget_hours: z.number().positive(),
        minimum_free_disk_gib_before_launch: z.number().positive(),
        pause_if_free_disk_below_gib: z.number().positive(),
      })
      .strict(),
    stop_and_resume: z
      .object({
        task_failure: z.literal("record-and-continue"),
        task_timeout: z.literal("record-and-continue"),
        provider_or_adapter_infrastructure_error: z.literal(
          "stop-campaign-and-invalidate-until-root-cause-fixed",
        ),
        secret_or_containment_violation: z.literal(
          "stop-campaign-and-invalidate",
        ),
        host_resource_floor: z.literal(
          "pause-between-trials-and-resume-same-job-without-retrying-completed-trials",
        ),
        outcome_based_retry_or_task_selection: z.literal("prohibited"),
      })
      .strict(),
    execution_gates: z
      .object({
        provider_zero_normal: z.literal("pass"),
        provider_zero_timeout_cancel: z.literal("pass"),
        single_task_real_provider: z.literal("pass"),
        exact_registry_catalog: z.literal("pass"),
        portable_agent_distribution: z.literal("pass"),
        prelaunch_disk_budget: z.literal("open"),
        explicit_execution_authorization: z.literal("open"),
        atif_trajectory_for_leaderboard_submission: z.literal("open"),
      })
      .strict(),
    interpretation: z
      .object({
        comparison_class_when_complete: z.literal("official-protocol"),
        incomplete_run_class: z.literal("internal-only"),
        leaderboard_submission_ready: z.literal(false),
        prohibited_claims_before_completion: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((preregistration, context) => {
    if (
      (preregistration.amended_at === undefined) !==
      (preregistration.amendment === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "full preregistration amendment timestamp and record must coexist",
      });
    }
  });

export type HarborFullPreregistration = z.infer<
  typeof harborFullPreregistrationSchema
>;

export interface HarborFullJobConfig {
  job_name: string;
  jobs_dir: string;
  n_attempts: number;
  install_only: false;
  timeout_multiplier: number;
  agent_timeout_multiplier: null;
  verifier_timeout_multiplier: null;
  agent_setup_timeout_multiplier: null;
  environment_build_timeout_multiplier: null;
  n_concurrent_trials: number;
  quiet: true;
  retry: {
    max_retries: number;
  };
  environment: {
    type: "docker";
    force_build: false;
    delete: true;
    cpu_enforcement_policy: "auto";
    memory_enforcement_policy: "auto";
  };
  verifier: {
    disable: false;
  };
  agents: readonly {
    name: string;
    model_name: string;
    extra_allowed_hosts: readonly ["host.docker.internal"];
  }[];
  datasets: readonly {
    name: string;
    ref: string;
    task_names: readonly string[];
  }[];
}

export function harborTaskCatalogSha256(
  tasks: readonly z.infer<typeof catalogTaskSchema>[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        tasks: tasks.map(({ order, name, ref }) => ({ order, name, ref })),
      }),
      "utf8",
    )
    .digest("hex");
}

export function parseHarborFullPreregistration(
  value: unknown,
): HarborFullPreregistration {
  const preregistration = harborFullPreregistrationSchema.parse(value);
  const tasks = preregistration.dataset.tasks;
  const expectedNames = tasks.map((task) => task.name);
  const uniqueNames = new Set(expectedNames);
  const uniqueRefs = new Set(tasks.map((task) => task.ref));

  if (
    tasks.some((task, index) => task.order !== index + 1) ||
    tasks.length !== preregistration.dataset.task_count
  ) {
    throw new TypeError(
      "full preregistration task catalog must be contiguous and match task_count",
    );
  }
  if (uniqueNames.size !== tasks.length || uniqueRefs.size !== tasks.length) {
    throw new TypeError(
      "full preregistration task catalog names and refs must be unique",
    );
  }
  if (
    JSON.stringify(preregistration.selection.include_task_names) !==
    JSON.stringify(expectedNames)
  ) {
    throw new TypeError(
      "full preregistration selection must preserve exact registry task order",
    );
  }
  if (
    preregistration.selection.attempts !==
    preregistration.official_protocol.leaderboard_attempts
  ) {
    throw new TypeError(
      "full preregistration attempts must match the leaderboard protocol",
    );
  }
  if (
    preregistration.selection.expected_trials !==
    tasks.length * preregistration.selection.attempts
  ) {
    throw new TypeError("full preregistration expected trial count is invalid");
  }
  if (
    preregistration.dataset.catalog_sha256 !==
    harborTaskCatalogSha256(tasks)
  ) {
    throw new TypeError("full preregistration task catalog digest mismatch");
  }
  if (
    preregistration.operational_budget.max_upstream_requests !==
    preregistration.selection.expected_trials *
      preregistration.adapter.broker_max_requests_per_trial
  ) {
    throw new TypeError(
      "full preregistration upstream request budget is inconsistent",
    );
  }
  if (
    preregistration.operational_budget.pause_if_free_disk_below_gib >=
    preregistration.operational_budget.minimum_free_disk_gib_before_launch
  ) {
    throw new TypeError(
      "full preregistration disk pause floor must be below its launch floor",
    );
  }
  if (
    JSON.stringify(
      preregistration.adapter.artifacts.map(({ platform }) => platform),
    ) !== JSON.stringify(["linux-aarch64", "linux-x86_64"])
  ) {
    throw new TypeError(
      "full preregistration must pin both Grok Linux artifacts in canonical order",
    );
  }
  return preregistration;
}

export function buildHarborFullJobConfig(
  preregistration: HarborFullPreregistration,
): HarborFullJobConfig {
  const parsed = parseHarborFullPreregistration(preregistration);
  return {
    job_name: "tb21-full-solar-grok-v0",
    jobs_dir: "jobs",
    n_attempts: parsed.selection.attempts,
    install_only: false,
    timeout_multiplier: parsed.official_protocol.timeout_multiplier,
    agent_timeout_multiplier:
      parsed.official_protocol.agent_timeout_multiplier,
    verifier_timeout_multiplier:
      parsed.official_protocol.verifier_timeout_multiplier,
    agent_setup_timeout_multiplier:
      parsed.official_protocol.agent_setup_timeout_multiplier,
    environment_build_timeout_multiplier:
      parsed.official_protocol.environment_build_timeout_multiplier,
    n_concurrent_trials: parsed.selection.concurrency,
    quiet: true,
    retry: {
      max_retries: parsed.selection.retries,
    },
    environment: {
      type: parsed.official_protocol.environment_type,
      force_build: false,
      delete: true,
      cpu_enforcement_policy:
        parsed.official_protocol.cpu_enforcement_policy,
      memory_enforcement_policy:
        parsed.official_protocol.memory_enforcement_policy,
    },
    verifier: {
      disable: parsed.official_protocol.verifier_disabled,
    },
    agents: [
      {
        name: parsed.adapter.import_path,
        model_name: `${parsed.adapter.provider}/${parsed.adapter.model}`,
        extra_allowed_hosts: ["host.docker.internal"],
      },
    ],
    datasets: [
      {
        name: parsed.dataset.id,
        ref: parsed.dataset.ref,
        task_names: parsed.selection.include_task_names,
      },
    ],
  };
}

function firstDifference(
  expected: unknown,
  observed: unknown,
  path = "$",
): string | null {
  if (Object.is(expected, observed)) return null;
  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index],
        observed[index],
        `${path}[${index}]`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (
    expected !== null &&
    observed !== null &&
    typeof expected === "object" &&
    typeof observed === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(observed)
  ) {
    const expectedRecord = expected as Record<string, unknown>;
    const observedRecord = observed as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord).sort();
    const observedKeys = Object.keys(observedRecord).sort();
    if (JSON.stringify(expectedKeys) !== JSON.stringify(observedKeys)) {
      return `${path} keys`;
    }
    for (const key of expectedKeys) {
      const difference = firstDifference(
        expectedRecord[key],
        observedRecord[key],
        `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  return path;
}

export function assertHarborFullJobConfig(
  preregistration: HarborFullPreregistration,
  observed: unknown,
): asserts observed is HarborFullJobConfig {
  const expected = buildHarborFullJobConfig(preregistration);
  const difference = firstDifference(expected, observed);
  if (difference !== null) {
    throw new TypeError(
      `Harbor full job config drifted from preregistration at ${difference}`,
    );
  }
}

export function expectedHarborFullLockOrder(
  preregistration: HarborFullPreregistration,
): readonly {
  attempt: number;
  name: string;
  ref: string;
}[] {
  const parsed = parseHarborFullPreregistration(preregistration);
  return Array.from(
    { length: parsed.selection.attempts },
    (_, index) => index + 1,
  ).flatMap((attempt) =>
    parsed.dataset.tasks.map((task) => ({
      attempt,
      name: task.name,
      ref: task.ref,
    })),
  );
}

const fullResolvedLockSchema = z
  .object({
    schema_version: z.literal(2),
    harbor: z
      .object({
        version: z.string().min(1),
      })
      .passthrough(),
    n_concurrent_trials: z.number().int().positive(),
    retry: z
      .object({
        max_retries: z.number().int().nonnegative(),
      })
      .passthrough(),
    trials: z.array(
      z
        .object({
          schema_version: z.literal(1),
          task: z
            .object({
              name: z.string().min(1),
              digest: sha256Ref,
              source: z.string().min(1),
            })
            .passthrough(),
          install_only: z.boolean(),
          timeout_multiplier: z.number().positive(),
          agent_timeout_multiplier: z.number().positive().nullable().optional(),
          verifier_timeout_multiplier: z
            .number()
            .positive()
            .nullable()
            .optional(),
          agent_setup_timeout_multiplier: z
            .number()
            .positive()
            .nullable()
            .optional(),
          environment_build_timeout_multiplier: z
            .number()
            .positive()
            .nullable()
            .optional(),
          agent: z
            .object({
              name: z.string().min(1),
              model_name: z.string().min(1),
              extra_allowed_hosts: z.array(z.string()),
            })
            .passthrough(),
          environment: z
            .object({
              type: z.string().min(1),
              force_build: z.boolean(),
              delete: z.boolean(),
              cpu_enforcement_policy: z.string().min(1),
              memory_enforcement_policy: z.string().min(1),
              override_cpus: z.number().nullable().optional(),
              override_memory_mb: z.number().nullable().optional(),
              override_storage_mb: z.number().nullable().optional(),
              override_gpus: z.number().nullable().optional(),
              override_tpu: z.unknown().nullable().optional(),
            })
            .passthrough(),
          verifier: z
            .object({
              disable: z.boolean(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

export function assertHarborFullResolvedLock(
  preregistration: HarborFullPreregistration,
  observed: unknown,
): void {
  const parsed = parseHarborFullPreregistration(preregistration);
  const lock = fullResolvedLockSchema.parse(observed);
  const expected = expectedHarborFullLockOrder(parsed);

  if (lock.harbor.version !== parsed.adapter.harbor_version) {
    throw new TypeError("Harbor full lock version drifted");
  }
  if (
    lock.n_concurrent_trials !== parsed.selection.concurrency ||
    lock.retry.max_retries !== parsed.selection.retries
  ) {
    throw new TypeError("Harbor full lock concurrency or retry policy drifted");
  }
  if (lock.trials.length !== expected.length) {
    throw new TypeError(
      `Harbor full lock trial count drifted: expected ${expected.length}, observed ${lock.trials.length}`,
    );
  }

  for (let index = 0; index < expected.length; index += 1) {
    const trial = lock.trials[index]!;
    const task = expected[index]!;
    if (
      trial.task.name !== task.name ||
      trial.task.digest !== task.ref ||
      trial.task.source !== parsed.dataset.id
    ) {
      throw new TypeError(
        `Harbor full lock task identity/order drifted at trial ${index + 1}`,
      );
    }
    if (
      trial.install_only ||
      trial.timeout_multiplier !==
        parsed.official_protocol.timeout_multiplier ||
      !isAbsent(trial.agent_timeout_multiplier) ||
      !isAbsent(trial.verifier_timeout_multiplier) ||
      !isAbsent(trial.agent_setup_timeout_multiplier) ||
      !isAbsent(trial.environment_build_timeout_multiplier)
    ) {
      throw new TypeError(
        `Harbor full lock timeout protocol drifted at trial ${index + 1}`,
      );
    }
    if (
      trial.agent.name !== parsed.adapter.import_path ||
      trial.agent.model_name !==
        `${parsed.adapter.provider}/${parsed.adapter.model}` ||
      JSON.stringify(trial.agent.extra_allowed_hosts) !==
        JSON.stringify(["host.docker.internal"])
    ) {
      throw new TypeError(
        `Harbor full lock agent identity drifted at trial ${index + 1}`,
      );
    }
    const environment = trial.environment;
    if (
      environment.type !== parsed.official_protocol.environment_type ||
      environment.force_build ||
      !environment.delete ||
      environment.cpu_enforcement_policy !==
        parsed.official_protocol.cpu_enforcement_policy ||
      environment.memory_enforcement_policy !==
        parsed.official_protocol.memory_enforcement_policy ||
      !isAbsent(environment.override_cpus) ||
      !isAbsent(environment.override_memory_mb) ||
      !isAbsent(environment.override_storage_mb) ||
      !isAbsent(environment.override_gpus) ||
      !isAbsent(environment.override_tpu)
    ) {
      throw new TypeError(
        `Harbor full lock task resource protocol drifted at trial ${index + 1}`,
      );
    }
    if (trial.verifier.disable !== parsed.official_protocol.verifier_disabled) {
      throw new TypeError(
        `Harbor full lock verifier protocol drifted at trial ${index + 1}`,
      );
    }
  }
}
