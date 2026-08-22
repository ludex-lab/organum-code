export const DEFAULT_OPENCODE_ZEN_FREE_MODEL =
  "deepseek-v4-flash-free" as const;

export interface OpenCodeZenFreeModel {
  modelID: string;
  label: string;
  qualification: "coding-qualified" | "provider-zero-only";
}

/**
 * Exact bare IDs accepted by the Organum Code Zen upstream profile, reconciled
 * with https://dev.opencode.ai/docs/zen on 2026-08-19. Native
 * OpenCode configuration prefixes these IDs with `opencode/`; the brokered
 * profile deliberately does not.
 */
export const OPENCODE_ZEN_FREE_MODELS = [
  {
    modelID: DEFAULT_OPENCODE_ZEN_FREE_MODEL,
    label: "DeepSeek V4 Flash Free",
    qualification: "coding-qualified",
  },
  {
    modelID: "big-pickle",
    label: "Big Pickle",
    qualification: "provider-zero-only",
  },
  {
    modelID: "mimo-v2.5-free",
    label: "MiMo-V2.5 Free",
    qualification: "provider-zero-only",
  },
  {
    modelID: "laguna-s-2.1-free",
    label: "Laguna S 2.1 Free",
    qualification: "provider-zero-only",
  },
  {
    modelID: "ling-3.0-flash-free",
    label: "Ling-3.0-flash Free",
    qualification: "provider-zero-only",
  },
  {
    modelID: "longcat-2.0-free",
    label: "LongCat-2.0 Free",
    qualification: "provider-zero-only",
  },
  {
    modelID: "north-mini-code-free",
    label: "North Mini Code Free",
    qualification: "provider-zero-only",
  },
  {
    modelID: "nemotron-3-ultra-free",
    label: "Nemotron 3 Ultra Free",
    qualification: "provider-zero-only",
  },
] as const satisfies readonly OpenCodeZenFreeModel[];

export function openCodeZenFreeModel(
  modelID: string,
): OpenCodeZenFreeModel | undefined {
  return OPENCODE_ZEN_FREE_MODELS.find((entry) => entry.modelID === modelID);
}
