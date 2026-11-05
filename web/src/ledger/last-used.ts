import type { CategoryKind } from '@shared/categories';
import { onCacheCleared } from '../offline/cache';
import { quietly } from '../utils/quietly';

// The account and categories a person used last on this device, offered first when they
// add a transaction: the account, and a category for each kind. Only ids, kept per person
// and let go with the rest of what's kept when they sign out.

const PREFIX = 'mahnee:lastUsed:';

export interface LastUsed {
  accountId: string | null;
  categoryIds: Partial<Record<CategoryKind, string>>;
}

export function lastUsed(email: string | null): LastUsed {
  const nothing: LastUsed = { accountId: null, categoryIds: {} };
  if (email == null) return nothing;
  const kept = quietly(() => localStorage.getItem(`${PREFIX}${email}`));
  if (kept == null) return nothing;
  try {
    const value = JSON.parse(kept) as Partial<LastUsed>;
    return {
      accountId: typeof value.accountId === 'string' ? value.accountId : null,
      categoryIds: typeof value.categoryIds === 'object' ? { ...value.categoryIds } : {},
    };
  } catch {
    return nothing;
  }
}

/** Remembers the account and the category (for its kind) just used */
export function rememberUsed(
  email: string | null,
  used: { accountId: string; kind: CategoryKind; categoryId: string },
) {
  if (email == null) return;
  const before = lastUsed(email);
  const next: LastUsed = {
    accountId: used.accountId,
    categoryIds: { ...before.categoryIds, [used.kind]: used.categoryId },
  };
  quietly(() => localStorage.setItem(`${PREFIX}${email}`, JSON.stringify(next)));
}

// Signing out, or someone else signing in: what was used last goes with the rest
onCacheCleared(() =>
  quietly(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }),
);
