import type { CategoryKind } from '@shared/categories';
import { onCacheCleared } from '../offline/cache';
import { quietly } from '../utils/quietly';

// The account and categories a person used last on this device, offered first when they
// add a transaction: the account, a category for each kind, the account they last moved
// money to, and each kind's recent categories (Add's chips), newest first. Only ids, kept
// per person and let go with the rest of what's kept when they sign out.

const PREFIX = 'mahnee:lastUsed:';

/** How many recent categories of a kind are kept, as Add shows them */
export const MAX_RECENT_CATEGORIES = 5;

export interface LastUsed {
  accountId: string | null;
  categoryIds: Partial<Record<CategoryKind, string>>;
  /** Where the last transfer went */
  toAccountId: string | null;
  /** Each kind's categories used lately, newest first, each once (kept as `recent`) */
  recent: Partial<Record<CategoryKind, string[]>>;
}

/** A kept list of ids, passing over anything that isn't one */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is string => typeof v === 'string');
  return [...new Set(ids)].slice(0, MAX_RECENT_CATEGORIES);
}

export function lastUsed(email: string | null): LastUsed {
  const nothing: LastUsed = { accountId: null, categoryIds: {}, toAccountId: null, recent: {} };
  if (email == null) return nothing;
  const kept = quietly(() => localStorage.getItem(`${PREFIX}${email}`));
  if (kept == null) return nothing;
  try {
    const value = JSON.parse(kept) as Partial<Record<keyof LastUsed, unknown>>;
    const recent = (
      typeof value.recent === 'object' && value.recent != null ? value.recent : {}
    ) as Partial<Record<CategoryKind, unknown>>;
    return {
      accountId: typeof value.accountId === 'string' ? value.accountId : null,
      categoryIds:
        typeof value.categoryIds === 'object' && value.categoryIds != null
          ? { ...(value.categoryIds as LastUsed['categoryIds']) }
          : {},
      toAccountId: typeof value.toAccountId === 'string' ? value.toAccountId : null,
      recent: { expense: idList(recent.expense), income: idList(recent.income) },
    };
  } catch {
    return nothing;
  }
}

/**
 * Remembers the account and the category (for its kind) just used, or, for a transfer,
 * where it went (the account it came from is left for spending and income)
 */
export function rememberUsed(
  email: string | null,
  used: { accountId: string; kind: CategoryKind; categoryId: string } | { toAccountId: string },
) {
  if (email == null) return;
  const before = lastUsed(email);
  const next: LastUsed =
    'toAccountId' in used
      ? { ...before, toAccountId: used.toAccountId }
      : {
          ...before,
          accountId: used.accountId,
          categoryIds: { ...before.categoryIds, [used.kind]: used.categoryId },
          recent: {
            ...before.recent,
            [used.kind]: idList([used.categoryId, ...(before.recent[used.kind] ?? [])]),
          },
        };
  quietly(() => localStorage.setItem(`${PREFIX}${email}`, JSON.stringify(next)));
}

/** The categories of `kind` used lately on this device, newest first */
export const recentCategoryIds = (email: string | null, kind: CategoryKind): string[] =>
  lastUsed(email).recent[kind] ?? [];

// Signing out, or someone else signing in: what was used last goes with the rest
onCacheCleared(() =>
  quietly(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }),
);
