import type { Transaction } from '@shared/api';

// What an entry from Scheduled says where entries are listed (owner decision D8; R-Account
// "Bills · from Scheduled"): "from Scheduled", or "amount to check" until the person confirms
// an amount that changes

/** " · from Scheduled", " · amount to check", or nothing for an entry the person added */
export function scheduledNote(t: Pick<Transaction, 'scheduled'>): string {
  if (t.scheduled == null) return '';
  return t.scheduled.toCheck ? ' · amount to check' : ' · from Scheduled';
}
