import { createHash } from "node:crypto";

import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitRevision = z.string().regex(/^[0-9a-f]{40}$/);

const datasetFileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256,
  })
  .strict();

const splitCatalogSchema = z
  .object({
    count: z.number().int().positive(),
    ordering: z.literal("LC_ALL=C lexicographic instance_id with trailing newline"),
    sha256,
  })
  .strict();

export const sweBenchLitePreregistrationSchema = z
  .object({
    schema: z.literal("organum-code/swe-bench-lite-preregistration/v1"),
    status: z.literal("preregistered-preparation-only"),
    created_at: z.string().min(1),
    purpose: z.string().min(1),
    evaluator: z
      .object({
        repository: z.literal("https://github.com/SWE-bench/SWE-bench"),
        revision: gitRevision,
        entrypoint: z.literal("swebench.harness.run_evaluation"),
        environment: z.literal("docker"),
      })
      .strict(),
    dataset: z
      .object({
        id: z.literal("princeton-nlp/SWE-bench_Lite"),
        revision: gitRevision,
        config: z.literal("default"),
        files: z
          .object({
            dev: datasetFileSchema,
            test: datasetFileSchema,
          })
          .strict(),
        catalogs: z
          .object({
            dev: splitCatalogSchema.extend({
              ids: z.array(z.string().min(1)).min(1),
            }).strict(),
            test: splitCatalogSchema,
          })
          .strict(),
      })
      .strict(),
    development_micro: z
      .object({
        split: z.literal("dev"),
        comparison_class: z.literal("internal-development-subset"),
        selection_method: z.literal("lexicographic-quartiles-v1"),
        one_based_positions: z.tuple([
          z.number().int().positive(),
          z.number().int().positive(),
          z.number().int().positive(),
        ]),
        instance_ids: z.tuple([
          z.string().min(1),
          z.string().min(1),
          z.string().min(1),
        ]),
        attempts: z.literal(1),
        retries: z.literal(0),
        concurrency: z.literal(1),
        timeout_overrides: z.null(),
        resource_overrides: z.null(),
        execution_authorized: z.literal(false),
      })
      .strict(),
    full_test: z
      .object({
        split: z.literal("test"),
        instances: z.literal(300),
        comparison_class_when_complete: z.literal("official-protocol"),
        partial_run_class: z.literal("internal-only"),
        execution_authorized: z.literal(false),
      })
      .strict(),
    body: z
      .object({
        provider: z.literal("upstage"),
        model: z.literal("solar-open2"),
        initial_backend: z.literal("grok"),
        patch_generation_adapter: z.literal("planned"),
        provider_key_enters_actor: z.literal(false),
      })
      .strict(),
    resource_policy: z
      .object({
        docker_required_for_gold_and_scoring: z.literal(true),
        docker_data_root: z.literal("operator-selected-outside-repository"),
        minimum_free_gib_before_image_work: z.number().positive(),
        cache_level: z.literal("env"),
        clean_instance_images: z.literal(true),
      })
      .strict(),
    execution_gates: z
      .object({
        metadata_and_catalog: z.literal("pass"),
        pinned_dataset_file_audit: z.literal("pass"),
        selected_gold_docker_evaluation: z.literal("open"),
        native_patch_generation_adapter: z.literal("open"),
        provider_zero_patch_roundtrip: z.literal("open"),
        explicit_jj_execution_authorization: z.literal("open"),
      })
      .strict(),
    interpretation: z
      .object({
        direct_api_is_not_a_matched_agent_arm: z.literal(true),
        prohibited_claims_before_full_test: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.dataset.catalogs.dev.ids;
    if (ids.length !== value.dataset.catalogs.dev.count) {
      context.addIssue({
        code: "custom",
        message: "SWE-bench Lite dev catalog count mismatch",
      });
    }
    if (
      ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) >= 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "SWE-bench Lite dev catalog must be strictly sorted and unique",
      });
    }
    if (
      sweBenchLiteCatalogSha256(ids) !== value.dataset.catalogs.dev.sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "SWE-bench Lite dev catalog digest mismatch",
      });
    }
    const selection = sweBenchLiteQuartileSelection(ids);
    if (
      JSON.stringify(selection.oneBasedPositions) !==
        JSON.stringify(value.development_micro.one_based_positions) ||
      JSON.stringify(selection.instanceIDs) !==
        JSON.stringify(value.development_micro.instance_ids)
    ) {
      context.addIssue({
        code: "custom",
        message: "SWE-bench Lite development selection drifted",
      });
    }
    if (value.dataset.catalogs.test.count !== value.full_test.instances) {
      context.addIssue({
        code: "custom",
        message: "SWE-bench Lite full-test count mismatch",
      });
    }
  });

export type SweBenchLitePreregistration = z.infer<
  typeof sweBenchLitePreregistrationSchema
>;

export function sweBenchLiteCatalogSha256(
  ids: readonly string[],
): string {
  return createHash("sha256")
    .update(`${ids.join("\n")}\n`, "utf8")
    .digest("hex");
}

export function sweBenchLiteQuartileSelection(ids: readonly string[]): {
  oneBasedPositions: readonly [number, number, number];
  instanceIDs: readonly [string, string, string];
} {
  if (ids.length < 4) {
    throw new TypeError("SWE-bench Lite quartile selection needs at least four IDs");
  }
  const indexes = [1, 2, 3].map((quartile) =>
    Math.floor(((ids.length - 1) * quartile) / 4)
  ) as [number, number, number];
  return {
    oneBasedPositions: indexes.map((index) => index + 1) as [
      number,
      number,
      number,
    ],
    instanceIDs: indexes.map((index) => ids[index]!) as [
      string,
      string,
      string,
    ],
  };
}

export function parseSweBenchLitePreregistration(
  input: unknown,
): SweBenchLitePreregistration {
  return sweBenchLitePreregistrationSchema.parse(input);
}
