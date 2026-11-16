import type { Account } from '@shared/api';
import { navigate } from '../../hooks/useRoute';
import { change } from '../../ledger/ledger';
import { useAddEntry } from '../shell/add-entry';

// What an account's page and pane do: Add here and Transfer open Add with this account in
// From (Transfer on Transfer), Search opens Activity on it over every month, and Unarchive
// brings an archived one back in one tap (it was only set aside, so there's nothing to undo).
export function useAccountActions(account: Account) {
  const openAdd = useAddEntry();
  return {
    addHere: () => openAdd?.({ accountId: account.id, fromHere: true }),
    transfer: () => openAdd?.({ accountId: account.id, kind: 'transfer', fromHere: true }),
    search: () => navigate(`?activity&account=${account.id}&dates=all`),
    unarchive: () => change({ op: 'archiveAccount', id: account.id, archived: false }),
  };
}
