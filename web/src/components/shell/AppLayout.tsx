import type { ReactNode } from 'react';
import { useState } from 'react';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import type { Route } from '../../hooks/useRoute';
import { placeOf } from '../../hooks/useRoute';
import { focusSearch, useShortcuts } from '../../hooks/useShortcuts';
import { useAccounts } from '../../ledger/useLedger';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import classes from './AppLayout.module.css';
import OfflineNotice from './OfflineNotice';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import UpdateNotice from './UpdateNotice';

// The page, with the places around it and what floats over it: being offline or signed
// out, and a new version to reload into. Home, Activity, Plan, Accounts and an account's
// page have the places: a tab bar under phones' and tablets' pages, a sidebar beside a
// computer's. Settings and Import cover them, and so does the first run, before there's an
// account. Add (New entry, or N) opens a new entry, on the account whose page is open; it
// can't be used while every account is archived.
export default function AppLayout({ route, children }: { route: Route; children: ReactNode }) {
  const isDesktop = useIsDesktop();
  const { accounts, failed } = useAccounts();
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const place = placeOf(route);
  // Once the accounts are known (or couldn't be loaded, so the places still lead away)
  const shown = place != null && (accounts == null ? failed : accounts.length > 0);
  const running = accounts?.filter((a) => !a.archived);
  const addable = running == null ? null : running.length > 0;

  const add = () => {
    if (!addable) return;
    const here = route.view === 'account' && running?.some((a) => a.id === route.id);
    setEntry(here ? { transaction: null, accountId: route.id } : { transaction: null });
  };
  // The keys work from the start, but for the first run, which has nowhere to go
  useShortcuts({ 'n': add, '/': focusSearch }, place != null && accounts?.length !== 0);

  const shell = !shown ? undefined : isDesktop ? 'sidebar' : 'tabs';
  return (
    <div
      className={classes.layout}
      data-shell={shell}
    >
      {shell === 'sidebar' && place != null && (
        <Sidebar
          place={place}
          addable={addable}
          onAdd={add}
        />
      )}
      <main className={classes.main}>{children}</main>
      {shell === 'tabs' && place != null && (
        <TabBar
          place={place}
          addable={addable}
          onAdd={add}
        />
      )}
      <EntrySheet
        open={entry}
        onClose={() => setEntry(null)}
      />
      <OfflineNotice />
      <UpdateNotice />
    </div>
  );
}
