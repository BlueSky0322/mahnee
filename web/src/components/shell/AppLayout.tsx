import type { ReactNode } from 'react';
import { useState } from 'react';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import type { Route } from '../../hooks/useRoute';
import { placeOf } from '../../hooks/useRoute';
import { focusSearch, useShortcuts } from '../../hooks/useShortcuts';
import { useAccounts } from '../../ledger/useLedger';
import { thisMonth } from '../../utils/date-input';
import Freshness from '../common/Freshness';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import { AddEntryContext } from './add-entry';
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
// can't be used while every account is archived. How fresh the figures are shows in the
// sidebar, and on a phone's or tablet's pages other than Home (which has its own) whenever
// it isn't "Up to date", so changes waiting are never out of sight.
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

  // A phone or tablet selecting on Activity has its own bar at the foot instead
  const selecting = route.view === 'activity' && route.select && !isDesktop;
  const shell = !shown ? undefined : isDesktop ? 'sidebar' : selecting ? undefined : 'tabs';
  // Home's open month, this one elsewhere
  const month = (route.view === 'home' ? route.month : null) ?? thisMonth();
  return (
    <div
      className={classes.layout}
      data-shell={shell}
    >
      {shell === 'sidebar' && place != null && (
        <Sidebar
          place={place}
          month={month}
          addable={addable}
          onAdd={add}
        />
      )}
      <main className={classes.main}>
        {shell === 'tabs' && place !== 'home' && (
          <div className={classes.freshness}>
            <Freshness
              month={month}
              onlyStale
            />
          </div>
        )}
        <AddEntryContext.Provider value={addable ? add : null}>{children}</AddEntryContext.Provider>
      </main>
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
