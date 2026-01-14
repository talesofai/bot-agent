const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafePathSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes("..");
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!isSafePathSegment(value)) {
    throw new Error(`${label} must be a safe path segment`);
  }
}
