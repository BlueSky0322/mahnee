import { Button, TextInput } from '@mantine/core';
import { useCurrency } from '../../profile/ProfileContext';
import { useNetwork } from '@mantine/hooks';
import { CloudSlash } from '@phosphor-icons/react';
import { ActivityIcon, DownIcon, SearchIcon } from '../ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Category, Transaction } from '@shared/api';
import { MAX_BULK_TRANSACTIONS } from '@shared/ledger';
import { MAX_SEARCH_TEXT } from '@shared/search';
import { useIsDesktop, useIsWide } from '../../hooks/useBreakpoints';
import { navigate, useLeaveGuard } from '../../hooks/useRoute';
import { takeSearchFocus, useShortcuts } from '../../hooks/useShortcuts';
import { addAgain, change } from '../../ledger/ledger';
import { useMonthStart } from '../../ledger/month-start';
import { holdsFrom } from '../../ledger/history';
import {
  useAccounts,
  useCategories,
  useHistoryUnavailable,
  useSearch,
} from '../../ledger/useLedger';
import type { Found as Totals } from '../../ledger/search-totals';
import { clockText, dayHeading, toDateInput } from '../../utils/date-input';
import { showRefusal } from '../../utils/notify';
import EntryTile from '../common/EntryTile';
import MainAmount from '../common/MainAmount';
import { amountWords, leavesOutText, typedAmount } from '../common/typed-amount';
import { categoryName } from '../common/category-name';
import { scheduledNote } from '../common/scheduled-note';
import { showUndo } from '../common/undo-toast';
import { useAddEntry } from '../shell/add-entry';
import Key from '../ui/Key';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import Skeleton, { Loading } from '../ui/Skeleton';
import ChangeCategory from './ChangeCategory';
import EntryEditor, { type EditorControl, type EditorTyped } from './EntryEditor';
import FilterChips from './Filters';
import {
  dayTotal,
  entriesText,
  foundLine,
  SIGNS,
  listAmount,
  noMatchLine,
  onDeviceLine,
  rowText,
  selectionLine,
  shortDay,
} from './activity-text';
import type { Filters } from './address';
import {
  NO_FILTERS,
  dayRange,
  isDefaultKinds,
  readFilters,
  searchOf,
  writeFilters,
} from './address';
import classes from './Activity.module.css';

/** How long typing rests before it's searched for */
const TYPING_MS = 250;
/** How long a row is pressed to start selecting with it */
const LONG_PRESS_MS = 500;
/** Placeholder rows while the first page loads */
const LOADING_ROWS = 5;

const TOO_MANY = `You can change up to ${MAX_BULK_TRANSACTIONS} transactions at once`;

// Activity (?activity; R-Activity, R-Desk-Activity): every entry, this month's on every
// account unless the filters (in the address, components/activity/address.ts) say
// otherwise, found by words in the payee, the note, the category or the amount. How many
// are found and what they came to count all of them, loaded or not (ledger/search-totals.ts).
// Phones and tablets list them by day, each day with its total; tapping one opens it in a
// sheet to change, and Select (or a long press) ticks several, with what's ticked at the
// foot. A computer shows a register, every row with a tick box and the open one beside it,
// moved through with J and K, ticked with X, recategorised with C; one too narrow for both
// (under 1200px) opens the row in a dialog instead, Enter opening the row J and K moved to. Change category and
// Delete act on what's ticked, up to MAX_BULK_TRANSACTIONS at once, each one change
// through the ledger with Undo. With nothing yet, or nothing found, it says so.
export default function ActivityPage({ query }: { query: string }) {
  const isDesktop = useIsDesktop();
  // A computer too narrow for the editor beside the register opens it in a dialog
  const beside = useIsWide();
  const inDialog = isDesktop === true && beside !== true;
  const { online } = useNetwork();
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const addEntry = useAddEntry();
  const today = toDateInput(new Date());
  const asked = useMemo(() => readFilters(query), [query]);

  // An account or category the person doesn't have is left out, once that's known
  const known = accounts != null && categories != null;
  const filters: Filters = useMemo(
    () => ({
      ...asked,
      account:
        asked.account != null && known && !accounts.some((a) => a.id === asked.account)
          ? null
          : asked.account,
      category:
        asked.category != null && known && !categories.some((c) => c.id === asked.category)
          ? null
          : asked.category,
    }),
    [asked, known, accounts, categories],
  );
  const address = writeFilters(filters);
  // What made no sense, or lost to what wins over it, leaves the address
  useEffect(() => {
    if (window.location.search !== address) navigate(address, { replace: true });
  }, [address]);
  // The filters as last drawn, so a change made later (the words, once typing rests) keeps
  // a chip picked in the meantime
  const latest = useRef(filters);
  latest.current = filters;
  const setFilters = (next: Partial<Filters>) =>
    navigate(writeFilters({ ...latest.current, ...next }), { replace: true });

  // Typing rests a moment before it's searched for, and is kept in the address
  const [searchFocused] = useState(takeSearchFocus);
  const [text, setText] = useState(filters.q);
  const typed = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== typed.current) {
      typed.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const q = text.trim();
    if (q === typed.current) return;
    const timer = setTimeout(() => {
      typed.current = q;
      setFilters({ q });
    }, TYPING_MS);
    return () => clearTimeout(timer);
    // Only the words start the wait; setFilters reads the latest filters through `latest`
  }, [text]);

  // Months are the person's (shared/period.ts)
  const start = useMonthStart();
  const search = useMemo(() => searchOf(filters, today, start), [filters, today, start]);
  const waiting = (filters.account != null || filters.category != null) && !known;
  const found = useSearch(search, { enabled: !waiting });
  const rows = found.transactions;

  // Drawn once the rows can be: until then, placeholders the size of what's to come
  const ready = rows != null && accounts != null && categories != null;
  const totals = ready ? found.totals : null;
  const days = dayRange(filters.days, today, start);
  // Offline, from a history this device doesn't hold every asked-for day of yet
  const partial = found.onDevice != null && !holdsFrom(found.onDevice, days.from);
  const unavailable = useHistoryUnavailable();
  const deviceLine = found.onDevice == null ? null : onDeviceLine(found.onDevice, days, today);
  // Entries typed offline with no rate yet count as nothing in the totals: said so
  const leavesOut = rows == null ? null : leavesOutText(rows);
  const currency = useCurrency();
  const nothingSet =
    filters.account == null &&
    filters.category == null &&
    isDefaultKinds(filters.kinds) &&
    filters.q === '';
  const empty = rows != null && rows.length === 0;
  // Nothing yet only when the person has no entry at all, as the server says: a transfer
  // alone (left out until asked for) is something, so the filters show, with nothing matching
  const nothingYet =
    empty &&
    nothingSet &&
    filters.days.kind === 'month' &&
    totals?.anywhere !== true &&
    (totals?.elsewhere ?? 0) === 0;
  const selecting = !isDesktop && filters.select;
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<Transaction[] | null>(null);
  const [sheet, setSheet] = useState<Transaction | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Not ticked any more once they're gone (deleted, or filtered out)
  const chosen = useMemo(() => (rows ?? []).filter((t) => ticked.has(t.id)), [rows, ticked]);
  // The editor open (beside the register, or in a phone's sheet), whether it has changes not
  // saved, and the entry it holds then: kept open even once a search leaves it out
  const editor = useRef<EditorControl | null>(null);
  const [dirty, setDirty] = useState(false);
  const [kept, setKept] = useState<Transaction | null>(null);
  const open =
    (rows ?? []).find((t) => t.id === openId) ??
    (kept != null && kept.id === openId ? kept : null) ??
    rows?.[0] ??
    null;
  // What would lose those changes, asked about first: another row (null for the first
  // found), leaving Activity, or closing the sheet
  const [ask, setAsk] = useState<Ask | null>(null);
  /** Opens a row beside the register; with changes not saved, asks first */
  const openRow = (id: string) => {
    if (open != null && id !== open.id && dirty) setAsk({ kind: 'row', id });
    else setOpenId(id);
  };
  /** A narrower computer's: the row is the one picked, and opens in a dialog */
  const openInDialog = (id: string) => {
    const row = rows?.find((t) => t.id === id);
    if (row == null) return;
    setOpenId(id);
    setSheet(row);
  };
  // J and K moved the row: a narrower computer's row takes the focus, so Enter opens it
  const [moved, setMoved] = useState(0);
  // The window growing or shrinking past where the pane fits moves the editor between the
  // pane and a dialog or sheet, one at a time, with what was typed: the editor's latest, and
  // what the next one starts from
  const typedNow = useRef<{ id: string; typed: EditorTyped; dirty: boolean } | null>(null);
  const [carried, setCarried] = useState<{ id: string; typed: EditorTyped } | null>(null);
  // Beside the register only on a computer wide enough; anywhere else the row opens over the
  // page (a dialog, or a phone's or tablet's sheet)
  const inPane = isDesktop === true && beside === true;
  const wasInPane = useRef(inPane);
  useEffect(() => {
    if (wasInPane.current === inPane) return;
    wasInPane.current = inPane;
    const typed = typedNow.current;
    if (!inPane) {
      if (open == null || typed?.id !== open.id || !typed.dirty) return;
      setCarried({ id: open.id, typed: typed.typed });
      setSheet(open);
    } else if (sheet != null) {
      if (typed?.id === sheet.id && typed.dirty) setCarried({ id: sheet.id, typed: typed.typed });
      setOpenId(sheet.id);
      setSheet(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the window crosses over
  }, [inPane]);
  const startFrom = (id: string) => (carried?.id === id ? carried.typed : undefined);
  const noteTyped = (id: string) => (typed: EditorTyped, changed: boolean) => {
    typedNow.current = { id, typed, dirty: changed };
    // Taken up once the editor has opened; a later opening starts from the entry as saved
    setCarried((now) => (now?.id === id ? null : now));
  };
  // The open entry, changed, is no longer among what's found: ask once
  const keptGone = dirty && kept != null && rows != null && !rows.some((t) => t.id === kept.id);
  useEffect(() => {
    if (keptGone) setAsk((asked) => asked ?? { kind: 'row', id: null });
  }, [keptGone]);
  // Leaving Activity asks too; its own filters don't leave it
  useLeaveGuard((search, go) => {
    if (!dirty || new URLSearchParams(search).has('activity')) return false;
    setAsk({ kind: 'leave', go });
    return true;
  });
  // Reloading or closing the tab: the browser's own question
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  /** Does what was asked about, the changes saved or not */
  const goOn = (asked: Ask) => {
    setAsk(null);
    if (asked.kind === 'row') {
      setKept(null);
      setOpenId(asked.id);
    } else if (asked.kind === 'leave') {
      setDirty(false);
      asked.go();
    } else {
      setDirty(false);
      setSheet(null);
    }
  };
  /** The sheet closes, or asks first when it has changes */
  const closeSheet = () => {
    if (dirty) setAsk({ kind: 'sheet' });
    else setSheet(null);
  };

  const toggle = (id: string) =>
    setTicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const selectAll = async () => {
    const all = await found.loadAll(MAX_BULK_TRANSACTIONS);
    setTicked(new Set(all.map((t) => t.id)));
  };
  const startSelecting = (first?: string) => {
    setTicked(new Set(first == null ? [] : [first]));
    setFilters({ select: true });
  };
  const stopSelecting = () => {
    setTicked(new Set());
    setFilters({ select: false });
  };

  /** Opens Change category for `those`, unless one change can't take them */
  const changeCategory = (those: Transaction[]) => {
    if (those.length === 0) return;
    if (those.length > MAX_BULK_TRANSACTIONS) return showRefusal(TOO_MANY);
    if (those.some((t) => t.kind === 'transfer')) {
      return showRefusal('Transfers have no category. Leave them out to change the category.');
    }
    if (new Set(those.map((t) => t.kind)).size > 1) {
      return showRefusal('Pick only spending, or only income, to change their category.');
    }
    setMoving(those);
  };
  const remove = () => {
    if (chosen.length === 0) return;
    if (chosen.length > MAX_BULK_TRANSACTIONS) return showRefusal(TOO_MANY);
    const gone = chosen;
    change({ op: 'removeTransactions', ids: gone.map((t) => t.id) });
    setTicked(new Set());
    // Undo adds each again, with its own id
    showUndo(`Deleted ${entriesText(gone.length)}`, () => addAgain(...gone));
  };

  // A computer's keys: J and K move the open row, X ticks it, C changes the category
  const step = (by: number) => {
    if (rows == null || rows.length === 0) return;
    const at = Math.max(
      0,
      rows.findIndex((t) => t.id === open?.id),
    );
    openRow(rows[Math.min(rows.length - 1, Math.max(0, at + by))].id);
    if (inDialog) setMoved((n) => n + 1);
  };
  useShortcuts(
    {
      j: () => step(1),
      k: () => step(-1),
      x: () => open != null && toggle(open.id),
      c: () => changeCategory(chosen.length > 0 ? chosen : open == null ? [] : [open]),
    },
    isDesktop && rows != null && rows.length > 0,
  );

  const sheetTitle =
    sheet == null || accounts == null || categories == null
      ? null
      : rowText(sheet, { accounts, categories, q: '', selecting: false, today }).title;
  const categoryShown =
    filters.category == null ? null : categoryName(categories ?? [], filters.category);
  const count = totals?.found.entries ?? 0;
  const paneTitle =
    open == null || accounts == null || categories == null
      ? null
      : rowText(open, { accounts, categories, q: '', selecting: false, today }).title;

  return (
    <div
      className={classes.page}
      data-layout={isDesktop ? 'register' : 'list'}
    >
      <header className={classes.header}>
        {selecting ? (
          <>
            <h1 className={classes.selectingTitle}>{ticked.size} selected</h1>
            <Button
              variant="light"
              size="xs"
              className={classes.quiet}
              onClick={stopSelecting}
            >
              Done
            </Button>
          </>
        ) : (
          <>
            <h1 className={classes.title}>Activity</h1>
            {!isDesktop && !nothingYet && (
              <Button
                variant="light"
                size="xs"
                className={classes.quiet}
                onClick={() => startSelecting()}
              >
                Select
              </Button>
            )}
          </>
        )}
        {!selecting && !(nothingYet && !isDesktop) && (
          <TextInput
            type="search"
            aria-label="Search"
            className={classes.search}
            autoFocus={searchFocused}
            placeholder="Payee, note, category or amount"
            leftSection={<SearchIcon size={isDesktop ? 18 : 20} />}
            leftSectionWidth={isDesktop ? 42 : 44}
            leftSectionProps={{ className: 'sf-lead' }}
            rightSection={isDesktop ? <Key>/</Key> : undefined}
            maxLength={MAX_SEARCH_TEXT}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        )}
      </header>

      <div
        className={classes.chips}
        role="group"
        aria-label="Filters"
        hidden={nothingYet}
      >
        <FilterChips
          filters={filters}
          today={today}
          onlySet={selecting}
          carets={!isDesktop && !selecting}
          onChange={setFilters}
        />
        {isDesktop && totals != null && (
          <span className={classes.found}>
            <FoundLine
              totals={totals}
              currency={currency}
              partial={partial}
            />
          </span>
        )}
      </div>

      {!isDesktop && totals != null && count > 0 && (
        <div className={classes.foundRow}>
          {selecting ? (
            <>
              <span className={classes.found}>
                {foundLine(totals.found, currency, { category: categoryShown }, partial)}
              </span>
              <Button
                variant="subtle"
                size="compact-sm"
                className={classes.selectAll}
                onClick={() => void selectAll()}
              >
                Select all {count}
              </Button>
            </>
          ) : (
            <span className={classes.found}>
              <FoundLine
                totals={totals}
                currency={currency}
                partial={partial}
              />
            </span>
          )}
        </div>
      )}

      <div className={classes.body}>
        <section
          className={classes.results}
          aria-label="Results"
        >
          {ready && deviceLine != null && (
            <p
              className={classes.muted}
              role="status"
            >
              {deviceLine}
            </p>
          )}
          {ready && leavesOut != null && (
            <p
              className={classes.muted}
              role="status"
            >
              {leavesOut}
            </p>
          )}
          {!ready || rows == null || accounts == null || categories == null ? (
            !online ? (
              <div className={classes.state}>
                <span className={classes.stateIcon}>
                  <CloudSlash size={24} />
                </span>
                <h2 className={classes.stateTitle}>Connect to search</h2>
                <p className={classes.muted}>
                  {unavailable
                    ? "This device couldn't keep your entries, so searching needs a connection."
                    : "Your entries aren't on this device yet."}
                </p>
              </div>
            ) : found.failed ? (
              <div className={classes.state}>
                <p className={classes.muted}>
                  Couldn't search. Check the connection and try again.
                </p>
                <Button
                  variant="default"
                  onClick={found.retry}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <Placeholders />
            )
          ) : nothingYet ? (
            <div
              className={classes.state}
              data-state="none"
            >
              <span className={classes.stateIcon}>
                <ActivityIcon size={24} />
              </span>
              <h2 className={classes.stateTitle}>No transactions yet</h2>
              <p className={classes.muted}>
                {isDesktop
                  ? 'Entries show here, newest first. Press N to add one.'
                  : 'Entries show here, newest first.'}
              </p>
              <div className={classes.stateActions}>
                <Button
                  disabled={addEntry == null}
                  onClick={() => addEntry?.()}
                  rightSection={isDesktop ? <Key>N</Key> : undefined}
                >
                  Log your first one
                </Button>
                <Button
                  variant="default"
                  onClick={() => navigate('?import')}
                >
                  Import a bank's CSV
                </Button>
              </div>
            </div>
          ) : empty ? (
            <div
              className={classes.state}
              data-state="no-match"
            >
              <span className={classes.stateIcon}>
                <SearchIcon size={24} />
              </span>
              <h2 className={classes.stateTitle}>No transactions match</h2>
              <p className={classes.muted}>
                {noMatchLine(
                  {
                    q: filters.q,
                    category: categoryShown,
                    ...days,
                    elsewhere: totals?.elsewhere ?? null,
                  },
                  today,
                  start,
                )}
              </p>
              <div className={classes.stateActions}>
                {!(
                  filters.account == null &&
                  filters.category == null &&
                  isDefaultKinds(filters.kinds)
                ) && (
                  <Button
                    variant="default"
                    onClick={() => setFilters(NO_FILTERS)}
                  >
                    Clear filters
                  </Button>
                )}
                {filters.days.kind !== 'all' && (
                  <Button
                    variant="default"
                    onClick={() => setFilters({ days: { kind: 'all' } })}
                  >
                    Search all months
                  </Button>
                )}
              </div>
            </div>
          ) : isDesktop ? (
            <Register
              rows={rows}
              accounts={accounts}
              categories={categories}
              today={today}
              q={filters.q}
              ticked={ticked}
              count={count}
              openId={open?.id ?? null}
              onOpen={inDialog ? openInDialog : openRow}
              inDialog={inDialog}
              moved={moved}
              onToggle={toggle}
              onSelectAll={() =>
                ticked.size > 0 && ticked.size >= count ? setTicked(new Set()) : void selectAll()
              }
              onChangeCategory={changeCategory}
              onDelete={remove}
              chosen={chosen}
            />
          ) : (
            <DayList
              rows={rows}
              totals={totals}
              accounts={accounts}
              categories={categories}
              today={today}
              q={filters.q}
              currency={currency}
              ticked={selecting ? ticked : null}
              onOpen={setSheet}
              onToggle={toggle}
              onLongPress={(id) => startSelecting(id)}
            />
          )}
          {rows != null && rows.length > 0 && found.hasMore && (
            <Button
              variant="default"
              className={classes.loadMore}
              loading={found.loadingMore}
              onClick={found.loadMore}
            >
              Load more
            </Button>
          )}
        </section>

        {inPane && sheet == null && open != null && paneTitle != null && (
          <aside
            className={classes.pane}
            aria-label={`${paneTitle}, ${shortDay(open.date, today)}${
              open.time != null ? `, ${clockText(open.time)}` : ''
            }`}
          >
            <EntryEditor
              key={open.id}
              transaction={open}
              title={paneTitle}
              control={editor}
              startFrom={startFrom(open.id)}
              onTyped={noteTyped(open.id)}
              onDirty={(changed) => {
                setDirty(changed);
                // Kept open as it is while it has changes
                setKept(changed ? open : null);
                if (changed) setOpenId(open.id);
              }}
              onDeleted={() => {
                // The next one opens, or the one before at the end
                const at = (rows ?? []).findIndex((t) => t.id === open.id);
                setOpenId((rows ?? [])[at + 1]?.id ?? (rows ?? [])[at - 1]?.id ?? null);
              }}
            />
          </aside>
        )}
      </div>

      {selecting && (
        <div className={classes.selectionBar}>
          <p className={classes.found}>{selectionLine(chosen, currency)}</p>
          <div className={classes.selectionActions}>
            <Button
              variant="default"
              className="sf-danger-outline"
              disabled={chosen.length === 0}
              onClick={remove}
            >
              Delete {chosen.length}
            </Button>
            <Button
              disabled={chosen.length === 0}
              onClick={() => changeCategory(chosen)}
            >
              Change category
            </Button>
          </div>
        </div>
      )}

      <ChangeCategory
        chosen={moving}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          setTicked(new Set());
        }}
      />
      <ResponsiveDialog
        opened={sheet != null}
        onClose={closeSheet}
        onBack={() => {
          // Kept open to ask first
          if (dirty) {
            setAsk({ kind: 'sheet' });
            return false;
          }
          setSheet(null);
        }}
        title={sheetTitle ?? ''}
      >
        {sheet != null && (
          <EntryEditor
            key={sheet.id}
            transaction={sheet}
            control={editor}
            onDirty={setDirty}
            saveInView={inDialog}
            startFrom={startFrom(sheet.id)}
            onTyped={noteTyped(sheet.id)}
            onDeleted={() => setSheet(null)}
            onSaved={() => setSheet(null)}
          />
        )}
      </ResponsiveDialog>
      <ResponsiveDialog
        opened={ask != null}
        onClose={() => setAsk(null)}
        title="Save your changes?"
        width={400}
      >
        <p className={classes.leaveText}>{`${
          (ask?.kind === 'sheet' ? sheetTitle : paneTitle) ?? 'This entry'
        } has changes that are not saved.`}</p>
        <div className={classes.leaveActions}>
          <Button
            variant="default"
            onClick={() => setAsk(null)}
          >
            Keep editing
          </Button>
          <Button
            variant="default"
            className="sf-danger-outline"
            onClick={() => ask != null && goOn(ask)}
          >
            Discard
          </Button>
          <Button
            onClick={() => {
              if (ask == null) return;
              // What can't be saved stays open, saying why
              if (editor.current?.save() === true) goOn(ask);
              else setAsk(null);
            }}
          >
            Save
          </Button>
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/** What changes not saved would be lost to, asked about first */
type Ask =
  | { kind: 'row'; id: string | null }
  | { kind: 'leave'; go: () => void }
  | { kind: 'sheet' };

/** "7 found · RM 92.05 spent", the amounts each in even-width figures */
function FoundLine({
  totals,
  currency,
  partial,
}: {
  totals: Totals;
  currency: string;
  partial: boolean;
}) {
  return <span className="sf-tabular">{foundLine(totals.found, currency, null, partial)}</span>;
}

function Placeholders() {
  return (
    <Loading
      label="Loading Activity"
      className={classes.list}
    >
      {Array.from({ length: LOADING_ROWS }, (_, i) => (
        <div
          key={i}
          className={classes.row}
        >
          <Skeleton
            width={36}
            height={36}
          />
          <span className={classes.rowText}>
            <Skeleton
              width={i % 2 === 0 ? 110 : 80}
              height={16}
            />
            <Skeleton
              width={140}
              height={12}
            />
          </span>
          <Skeleton
            width={64}
            height={16}
          />
        </div>
      ))}
    </Loading>
  );
}

function Amount({ t, currency }: { t: Transaction; currency: string }) {
  return (
    <span
      className={`${classes.amount} sf-tabular`}
      data-kind={t.kind}
    >
      {typedAmount(t, SIGNS[t.kind]) ?? listAmount(t, currency)}
      <MainAmount
        t={t}
        currency={currency}
      />
    </span>
  );
}

function DayList({
  rows,
  totals,
  accounts,
  categories,
  today,
  q,
  currency,
  ticked,
  onOpen,
  onToggle,
  onLongPress,
}: {
  rows: Transaction[];
  totals: Totals | null;
  accounts: Account[];
  categories: Category[];
  today: string;
  q: string;
  currency: string;
  /** What's ticked while selecting; null when not selecting */
  ticked: Set<string> | null;
  onOpen: (t: Transaction) => void;
  onToggle: (id: string) => void;
  onLongPress: (id: string) => void;
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({
    timer: null,
    fired: false,
  });
  const letGo = () => {
    if (press.current.timer != null) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  useEffect(() => letGo, []);

  // Grouped by day, newest first, as they come
  const days: { day: string; rows: Transaction[] }[] = [];
  for (const t of rows) {
    const last = days.at(-1);
    if (last?.day === t.date) last.rows.push(t);
    else days.push({ day: t.date, rows: [t] });
  }
  const selecting = ticked != null;

  const row = (t: Transaction) => {
    const { title, subtitle } = rowText(t, {
      accounts,
      categories,
      q,
      selecting,
      today,
    });
    const name = `${title}, ${subtitle}, ${amountWords(t, listAmount(t, currency), SIGNS[t.kind], currency)}`;
    const body = (
      <>
        <span className={classes.rowText}>
          <span className={classes.rowTitle}>{title}</span>
          <span className={classes.rowSubtitle}>{subtitle}</span>
        </span>
        <Amount
          t={t}
          currency={currency}
        />
      </>
    );
    return (
      <li key={t.id}>
        {selecting ? (
          <label
            className={classes.row}
            // A fresh press, so the next tick is never mistaken for a long
            // press's release
            onPointerDown={() => (press.current.fired = false)}
          >
            <input
              type="checkbox"
              className={`sf-tick ${classes.tick}`}
              aria-label={name}
              checked={ticked.has(t.id)}
              onChange={() => {
                // The release of the long press that ticked it leaves it ticked
                if (press.current.fired) {
                  press.current.fired = false;
                  return;
                }
                onToggle(t.id);
              }}
            />
            {body}
          </label>
        ) : (
          <button
            type="button"
            className={classes.row}
            aria-label={name}
            onPointerDown={() => {
              letGo();
              press.current.fired = false;
              press.current.timer = setTimeout(() => {
                press.current.timer = null;
                press.current.fired = true;
                onLongPress(t.id);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={letGo}
            onPointerLeave={letGo}
            onPointerCancel={letGo}
            // A long press on a phone would open the browser's menu
            onContextMenu={(e) => {
              if (press.current.timer != null || press.current.fired) e.preventDefault();
            }}
            onClick={() => {
              // The press that started selecting isn't also a tap
              if (press.current.fired) {
                press.current.fired = false;
                return;
              }
              onOpen(t);
            }}
          >
            <EntryTile
              t={t}
              categories={categories}
            />
            {body}
          </button>
        )}
      </li>
    );
  };

  // Selecting, it's one list, each row saying its day (R-Activity-Select)
  if (selecting) {
    return (
      <ul
        className={`${classes.list} ${classes.selectingList}`}
        aria-label="Entries"
      >
        {rows.map(row)}
      </ul>
    );
  }

  return (
    <div className={classes.days}>
      {days.map(({ day, rows: onDay }) => {
        const heading = dayHeading(day);
        const total = totals?.days.get(day);
        const figure = total == null ? null : dayTotal(total, currency);
        return (
          <div
            key={day}
            className={classes.day}
          >
            <h2 className={classes.dayTitle}>
              <span>{heading}</span>
              {figure != null && <span className="sf-tabular">{figure}</span>}
            </h2>
            <ul
              className={classes.list}
              aria-label={heading}
            >
              {onDay.map(row)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Register({
  rows,
  accounts,
  categories,
  today,
  q,
  ticked,
  chosen,
  count,
  openId,
  onOpen,
  inDialog,
  moved,
  onToggle,
  onSelectAll,
  onChangeCategory,
  onDelete,
}: {
  rows: Transaction[];
  accounts: Account[];
  categories: Category[];
  today: string;
  q: string;
  ticked: Set<string>;
  chosen: Transaction[];
  count: number;
  openId: string | null;
  onOpen: (id: string) => void;
  /** The row opens in a dialog, not beside the register */
  inDialog: boolean;
  /** Counts J and K's moves, after each of which a dialog's row takes the focus */
  moved: number;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onChangeCategory: (those: Transaction[]) => void;
  onDelete: () => void;
}) {
  const currency = useCurrency();
  const opened = useRef<HTMLTableRowElement | null>(null);
  // Kept in view as J and K move it: a block, so what scrolling answers (a Promise, in
  // Chromium) is never taken for the effect's cleanup
  useEffect(() => {
    opened.current?.scrollIntoView({ block: 'nearest' });
  }, [openId]);
  useEffect(() => {
    if (moved > 0) opened.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [moved]);
  const allTicked = chosen.length > 0 && chosen.length >= count;
  return (
    <>
      <div className={classes.bar}>
        {chosen.length > 0 && (
          <>
            <strong className={classes.barCount}>{chosen.length} selected</strong>
            <Button
              size="xs"
              onClick={() => onChangeCategory(chosen)}
            >
              Change category
            </Button>
            <Button
              size="xs"
              variant="default"
              className="sf-danger-outline"
              onClick={onDelete}
            >
              Delete {chosen.length}
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="subtle"
          onClick={onSelectAll}
        >
          Select all {count}
        </Button>
        <span className={classes.hints}>
          <Key>J</Key>
          <Key>K</Key> move {inDialog && <Key>Enter</Key>}
          {inDialog && ' open '}
          <Key>X</Key> tick <Key>C</Key> category
        </span>
      </div>
      <div className={classes.tableWrap}>
        <table
          className={classes.table}
          aria-label="Transactions"
        >
          <colgroup>
            <col className={classes.colTick} />
            <col className={classes.colDate} />
            <col className={classes.colPayee} />
            <col className={classes.colCategory} />
            <col />
            <col className={classes.colAmount} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  className={`sf-tick ${classes.tick}`}
                  aria-label="Select all"
                  checked={allTicked}
                  onChange={onSelectAll}
                />
              </th>
              <th scope="col">Date</th>
              <th scope="col">Payee and note</th>
              <th scope="col">Category</th>
              <th scope="col">Account</th>
              <th
                scope="col"
                className={classes.right}
              >
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const { title, subtitle } = rowText(t, {
                accounts,
                categories,
                q,
                selecting: false,
                today,
              });
              const transfer = t.kind === 'transfer';
              const nameOf = (id: string | null) =>
                accounts.find((a) => a.id === id)?.name ?? 'another account';
              const what = transfer
                ? `${nameOf(t.accountId)} to ${nameOf(t.toAccountId)}`
                : nameOf(t.accountId);
              const isOpen = t.id === openId;
              return (
                <tr
                  key={t.id}
                  ref={isOpen ? opened : undefined}
                  aria-selected={isOpen}
                  data-ticked={ticked.has(t.id) || undefined}
                  className={classes.registerRow}
                  onClick={(e) => {
                    // A dialog's focus comes back to the row it was opened from
                    if (inDialog) e.currentTarget.querySelector('button')?.focus();
                    onOpen(t.id);
                  }}
                >
                  <td>
                    <input
                      type="checkbox"
                      className={`sf-tick ${classes.tick}`}
                      aria-label={`${title}, ${subtitle}, ${amountWords(t, listAmount(t, currency), SIGNS[t.kind], currency)}`}
                      checked={ticked.has(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggle(t.id)}
                    />
                  </td>
                  <td className={classes.muted}>
                    {shortDay(t.date, today)}
                    {t.time != null && `, ${clockText(t.time)}`}
                  </td>
                  <td className={classes.payee}>
                    {/* Opens the row beside the register (or in a dialog), from the keyboard too */}
                    <button
                      type="button"
                      className={classes.payeeButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(t.id);
                      }}
                    >
                      {[t.payee, t.note].filter(Boolean).join(' · ') || title}
                    </button>
                  </td>
                  <td>
                    {transfer ? (
                      <span className={classes.muted}>Transfer</span>
                    ) : (
                      <button
                        type="button"
                        className={classes.categoryButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          onChangeCategory([t]);
                        }}
                      >
                        {categoryName(categories, t.categoryId)}
                        <DownIcon
                          size={12}
                          aria-hidden
                        />
                      </button>
                    )}
                    {scheduledNote(t)}
                  </td>
                  <td className={classes.soft}>{what}</td>
                  <td className={classes.right}>
                    <Amount
                      t={t}
                      currency={currency}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
