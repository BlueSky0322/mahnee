/**
 * Runs something that touches browser storage, which can be unavailable (private
 * browsing, full, blocked): the app works without it, so a failure is just undefined
 */
export function quietly<T>(access: () => T): T | undefined {
  try {
    return access();
  } catch {
    return undefined;
  }
}
