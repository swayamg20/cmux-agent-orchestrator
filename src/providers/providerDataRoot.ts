import path from "node:path";

const MAX_PROVIDER_DATA_ROOT_LENGTH = 4_096;

export function resolveProviderDataRoot(
  configured: string | undefined,
  fallback: string
): string {
  return configured !== undefined &&
    configured.length <= MAX_PROVIDER_DATA_ROOT_LENGTH &&
    path.isAbsolute(configured) &&
    !configured.includes("\0")
    ? path.normalize(configured)
    : fallback;
}
