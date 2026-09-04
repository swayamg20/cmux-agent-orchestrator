const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

export function normalizeCanonicalUuid(value: string): string | null {
  return isCanonicalUuid(value) ? value.toLowerCase() : null;
}

export function canonicalUuidEquals(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (left == null || right == null) return false;
  const normalizedLeft = normalizeCanonicalUuid(left);
  return normalizedLeft !== null && normalizedLeft === normalizeCanonicalUuid(right);
}
