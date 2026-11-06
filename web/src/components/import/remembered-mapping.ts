import type { ColumnMapping } from '@shared/csv-import';
import { onCacheCleared } from '../../offline/cache';
import { quietly } from '../../utils/quietly';

// Which column of a bank's file holds what, remembered per person and account on this
// device, so the next statement from the same bank is mapped already. Only column names,
// never anything from the file's rows; let go with the rest of what's kept on signing out.

const PREFIX = 'mahnee:importMapping:';
const keyFor = (email: string, accountId: string) => `${PREFIX}${email}:${accountId}`;

const isName = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** The mapping last used for `accountId`, or null */
export function rememberedMapping(email: string | null, accountId: string): ColumnMapping | null {
  if (email == null) return null;
  const kept = quietly(() => localStorage.getItem(keyFor(email, accountId)));
  if (kept == null) return null;
  try {
    const v = JSON.parse(kept) as Record<keyof ColumnMapping, unknown>;
    const { date, amount, moneyIn, moneyOut, payee, note } = v;
    if (typeof date !== 'string' || ![amount, moneyIn, moneyOut, payee, note].every(isName)) {
      return null;
    }
    return { date, amount, moneyIn, moneyOut, payee, note } as ColumnMapping;
  } catch {
    return null;
  }
}

export function rememberMapping(email: string | null, accountId: string, mapping: ColumnMapping) {
  if (email == null) return;
  quietly(() => localStorage.setItem(keyFor(email, accountId), JSON.stringify(mapping)));
}

// Signing out, or someone else signing in: the mappings go with the rest
onCacheCleared(() =>
  quietly(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }),
);
