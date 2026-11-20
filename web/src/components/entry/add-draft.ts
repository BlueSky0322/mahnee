import { readCategoryName } from '@shared/categories';
import { isKeypadSum } from '@shared/keypad';
import type { TransactionKind } from '@shared/ledger';
import {
  MAX_NOTE,
  MAX_PAYEE,
  MAX_TRANSACTION_CENTS,
  isDay,
  isTransactionKind,
} from '@shared/ledger';
import type { Schedule } from '@shared/recurring';
import { isSchedule } from '@shared/recurring';
import { MAX_TYPED_CENTS, isEntryCurrency } from '@shared/rates';
import { onCacheCleared } from '../../offline/cache';
import { toDateInput } from '../../utils/date-input';
import { quietly } from '../../utils/quietly';

// What was typed in Add and closed without saving: kept on this device for the person
// who typed it, and opened again as it was left, until it's saved or they sign out. Ids are
// only what was picked; Add checks them against the accounts and categories on reopening.

const PREFIX = 'mahnee:addDraft:';

export interface AddDraft {
  kind: TransactionKind;
  /** What the keypad typed, as `Keypad.expr` */
  expr: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  /** A category to make when it's saved, picked in place of `categoryId` */
  newCategory: { id: string; name: string; parentId: string | null } | null;
  payee: string;
  /** The note typed; missing when none (and from older drafts) */
  note?: string;
  /** The day picked, or null for Today, whichever day that is when it's opened again */
  date: string | null;
  repeat: Schedule | '';
  /** The currency it was typed in; missing for the home currency (and from older drafts) */
  currency?: string;
}

const isIdOrNone = (v: unknown): v is string | null => v === null || typeof v === 'string';

function isNewCategory(v: unknown): v is AddDraft['newCategory'] {
  if (v === null) return true;
  if (typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && readCategoryName(c.name) != null && isIdOrNone(c.parentId);
}

function isDraft(v: unknown): v is AddDraft {
  if (typeof v !== 'object' || v == null) return false;
  const d = v as Record<string, unknown>;
  return (
    isTransactionKind(d.kind) &&
    typeof d.expr === 'string' &&
    (d.currency === undefined || isEntryCurrency(d.currency)) &&
    // In another currency it may go past the home one's limit, to its own
    isKeypadSum(d.expr, d.currency === undefined ? MAX_TRANSACTION_CENTS : MAX_TYPED_CENTS) &&
    isIdOrNone(d.accountId) &&
    isIdOrNone(d.toAccountId) &&
    isIdOrNone(d.categoryId) &&
    isNewCategory(d.newCategory) &&
    typeof d.payee === 'string' &&
    d.payee.length <= MAX_PAYEE &&
    (d.note === undefined || (typeof d.note === 'string' && d.note.length <= MAX_NOTE)) &&
    (d.date === null || (isDay(d.date) && d.date <= toDateInput(new Date()))) &&
    (d.repeat === '' || isSchedule(d.repeat))
  );
}

/** The draft `email` left, or null when there's none (or it can't be read) */
export function readDraft(email: string | null): AddDraft | null {
  if (email == null) return null;
  const kept = quietly(() => localStorage.getItem(`${PREFIX}${email}`));
  if (kept == null) return null;
  try {
    const value: unknown = JSON.parse(kept);
    return isDraft(value) ? value : null;
  } catch {
    return null;
  }
}

export function keepDraft(email: string | null, draft: AddDraft) {
  if (email == null) return;
  quietly(() => localStorage.setItem(`${PREFIX}${email}`, JSON.stringify(draft)));
}

export function dropDraft(email: string | null) {
  if (email == null) return;
  quietly(() => localStorage.removeItem(`${PREFIX}${email}`));
}

// Signing out, or someone else signing in: drafts go with the rest of what's kept
onCacheCleared(() =>
  quietly(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }),
);
