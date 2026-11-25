import type { ReactNode } from 'react';
import { useState } from 'react';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useKeepScroll } from '../../hooks/useKeepScroll';
import type { Route } from '../../hooks/useRoute';
import { placeOf } from '../../hooks/useRoute';
import { focusSearch, useShortcuts } from '../../hooks/useShortcuts';
import { useAccounts } from '../../ledger/useLedger';
import { useForgetMonthsWhenTheStartChanges, useMonths } from '../../ledger/month-start';
import Freshness, { FreshnessProvider } from '../common/Freshness';
import AddEntry, { type AddRequest } from '../entry/AddEntry';
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
// account, and a category's own page under Plan on a phone or tablet. Add (New entry, or N)
// opens a new entry, on the account whose page is open; it can't be used while every
// account is archived. How fresh the figures are shows in the sidebar, and on a phone's or
// tablet's pages other than Home (which has its own) whenever something is wrong, so
// changes waiting are never out of sight; its problems are announced once, from here.
export default function AppLayout({ route, children }: { route: Route; children: ReactNode }) {
  const isDesktop = useIsDesktop();
  const { accounts, failed } = useAccounts();
  const [entry, setEntry] = useState<AddRequest | null>(null);
  const place = placeOf(route);
  // Once the accounts are known (or couldn't be loaded, so the places still lead away)
  const shown = place != null && (accounts == null ? failed : accounts.length > 0);
  const running = accounts?.filter((a) => !a.archived);
  const addable = running == null ? null : running.length > 0;

  const add = () => {
    if (!addable) return;
    const here = route.view === 'account' && running?.some((a) => a.id === route.id);
    setEntry(here ? { accountId: route.id } : {});
  };
  // A page's own request (an account's Add here or Transfer), else as Add opens
  const addFor = (request?: AddRequest) => {
    if (!addable) return;
    if (request == null) add();
    else setEntry(request);
  };
  // The keys work from the start, but for the first run, which has nowhere to go
  useShortcuts({ 'n': add, '/': focusSearch }, place != null && accounts?.length !== 0);

  // A phone or tablet selecting on Activity has its own bar at the foot instead, and a
  // category over 12 months is a page of its own under Plan, with Back to it
  const ownPage =
    !isDesktop &&
    ((route.view === 'activity' && route.select) ||
      (route.view === 'plan' && route.half === 'budgets' && route.category != null));
  const shell = !shown ? undefined : isDesktop ? 'sidebar' : ownPage ? undefined : 'tabs';
  // Home's open month, this one elsewhere: the person's (shared/period.ts)
  const { current } = useMonths();
  const homeMonth = route.view === 'home' ? route.month : null;
  const month = homeMonth != null && homeMonth < current.month ? homeMonth : current.month;
  // Months kept for the old days go when the day the month starts on changes
  useForgetMonthsWhenTheStartChanges();
  // Each page opens at the top, or where it was left when the person comes back to it
  useKeepScroll(pageOf(route, isDesktop === true), route);
  return (
    <FreshnessProvider month={month}>
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
          <AddEntryContext.Provider value={addable ? addFor : null}>
            {children}
          </AddEntryContext.Provider>
        </main>
        {shell === 'tabs' && place != null && (
          <TabBar
            place={place}
            addable={addable}
            onAdd={add}
          />
        )}
        <AddEntry
          open={entry}
          onClose={() => setEntry(null)}
        />
        <OfflineNotice />
        <UpdateNotice />
      </div>
    </FreshnessProvider>
  );
}

/**
 * The page as the person sees it, whose place on the screen is kept: a computer's account
 * opens beside the list, and its category beside Plan's table, so each is still that page
 */
function pageOf(route: Route, isDesktop: boolean): string {
  switch (route.view) {
    case 'home':
    case 'activity':
    case 'accounts':
    case 'import':
      return route.view;
    case 'account':
      return isDesktop ? 'accounts' : `account:${route.id}`;
    case 'plan':
      return `plan:${route.half}${!isDesktop && route.category != null ? `:${route.category}` : ''}`;
    case 'settings':
      return `settings:${route.section ?? ''}`;
  }
}
