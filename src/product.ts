export const ORGANUM_CODE_PRODUCT = "organum-code" as const;
export const ORGANUM_CODE_VERSION = "0.1.0-preview.1" as const;
export const ORGANUM_CODE_RELEASE_CHANNEL = "internal-preview" as const;

export function organumCodeVersionLine(): string {
  return `${ORGANUM_CODE_PRODUCT} ${ORGANUM_CODE_VERSION}`;
}
