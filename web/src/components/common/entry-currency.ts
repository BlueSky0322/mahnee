import { useState } from 'react';
import type { LedgerChange, Original, Transaction } from '@shared/api';
import { convertCents } from '@shared/rates';
import type { ShownRate } from '../../hooks/useRate';
import { useRate } from '../../hooks/useRate';
import { change, changeTyped } from '../../ledger/ledger';
import { useCurrency, useProfile } from '../../profile/ProfileContext';

// The currency an entry is typed in, as its editors change it (Activity's and an account's):
// the home currency, the person's other currencies, or the one it was typed in. An amount
// in another currency is sent as typed, for the server to convert at the entry's day's
// rate, and shown meanwhile at today's rate on this device.

type Update = Extract<LedgerChange, { op: 'updateTransaction' }>;

/** The entry's currency and what an editor offers, with today's rate for it */
export function useEntryCurrency(editing: Transaction) {
  const home = useCurrency();
  const others = useProfile().profile?.settings.otherCurrencies ?? [];
  const [typedIn, setTypedIn] = useState(editing.original?.currency ?? home);
  const options = [...new Set([home, ...others, editing.original?.currency ?? home])];
  const rate = useRate(typedIn, home, { enabled: typedIn !== home });
  return {
    home,
    typedIn,
    setTypedIn,
    options,
    quote: typedIn !== home ? rate.data ?? null : null,
    /** The amount as it was typed, in the currency it was typed in */
    typedCents: editing.original?.cents ?? editing.amountCents,
  };
}

/**
 * Whether an edit sends the amount: it, or its currency, changed; or (in another currency
 * than the home one) its day did, so it's converted at the new day's rate
 */
export function sendsAmount(
  editing: Transaction,
  cents: number,
  typedIn: string,
  home: string,
  dayChanged: boolean,
) {
  const was = editing.original ?? { currency: home, cents: editing.amountCents };
  return typedIn !== was.currency || cents !== was.cents || (typedIn !== home && dayChanged);
}

/**
 * Sends an entry's edit, then `more` changes. Its amount in another currency is sent as
 * typed and shown at `quote`'s rate. False, sending nothing, when that needs a rate there
 * isn't one for.
 */
export function sendEdit(
  update: Update,
  more: LedgerChange[],
  { typedIn, home, quote }: { typedIn: string; home: string; quote: ShownRate | null },
): boolean {
  const changed = Object.keys(update).length > 2;
  if (typedIn === home || update.amountCents == null) {
    const changes = changed ? [update, ...more] : more;
    if (changes.length > 0) change(...changes);
    return true;
  }
  if (quote == null) return false;
  const original: Original = {
    currency: typedIn,
    cents: update.amountCents,
    rate: quote.rate,
    source: quote.source,
    at: quote.fetchedAt,
  };
  const shown = {
    ...update,
    amountCents: Math.max(1, convertCents(update.amountCents, quote.rate)),
    original,
  } as Update;
  changeTyped(typedIn, [update], [shown]);
  if (more.length > 0) change(...more);
  return true;
}
