import { Button, NativeSelect, TextInput } from '@mantine/core';
import { CaretLeft, MagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Category, LedgerChange, Transaction } from '@shared/api';
import { MAX_BULK_TRANSACTIONS } from '@shared/ledger';
import type { SearchQuery } from '@shared/search';
import { MAX_SEARCH_TEXT } from '@shared/search';
import { goUp } from '../../hooks/useRoute';
import { change } from '../../ledger/ledger';
import { useAccounts, useCategories, useSearch } from '../../ledger/useLedger';
import { dayHeading } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import { showRefusal } from '../../utils/notify';
import { categoryName } from '../common/category-name';
import { showUndo } from '../common/undo-toast';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import { transactionSummary } from '../entry/entry-text';
import Skeleton, { Loading } from '../ui/Skeleton';
import BulkDialogs, { type BulkAction } from './BulkDialogs';
import { categoryOptions, transactionsText } from './search-text';
import classes from './SearchPage.module.css';

/** How long typing rests before it's searched for */
const TYPING_MS = 250;
/** How long a row is pressed to start selecting with it */
const LONG_PRESS_MS = 500;
/** Placeholder rows while the first page loads */
const LOADING_ROWS = 5;

const TOO_MANY = `You can change up to ${MAX_BULK_TRANSACTIONS} transactions at once`;

// Search (?search): what's typed is found in payees, notes, category names and amounts on
// every account, newest first, narrowed by account, category and days (shared/search.ts).
// Tap one to change it. Select (or a long press) ticks several, to move them to another
// category or delete them in one change, after a preview, with Undo; up to
// MAX_BULK_TRANSACTIONS at once.
export default function SearchPage() {
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<Omit<SearchQuery, 'q'>>({
    account: null,
    category: null,
    from: null,
    to: null,
  });
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), TYPING_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useMemo(() => ({ q, ...filters }), [q, filters]);
  const found = useSearch(query);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [action, setAction] = useState<BulkAction | null>(null);
  const [entry, setEntry] = useState<OpenEntry | null>(null);

  const shown = found.transactions;
  const chosen = useMemo(
    () => (selected == null ? [] : (shown ?? []).filter((t) => selected.has(t.id))),
    [selected, shown],
  );

  const filter = (key: keyof typeof filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value === '' ? null : value }));

  const toggle = (id: string) =>
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const selectAll = async () => {
    const all = await found.loadAll(MAX_BULK_TRANSACTIONS);
    setSelected(new Set(all.map((t) => t.id)));
  };

  /** Opens an action's preview, unless more are ticked than one change can take */
  const start = (next: BulkAction) => {
    if (chosen.length > MAX_BULK_TRANSACTIONS) {
      showRefusal(TOO_MANY);
      return;
    }
    if (next === 'move') {
      if (chosen.some((t) => t.kind === 'transfer')) {
        showRefusal('Transfers have no category. Leave them out to change the category.');
        return;
      }
      if (new Set(chosen.map((t) => t.kind)).size > 1) {
        showRefusal('Pick only spending, or only income, to change their category.');
        return;
      }
    }
    setAction(next);
  };

  const done = () => {
    setAction(null);
    setSelected(null);
  };

  const move = (categoryId: string) => {
    const ids = chosen.map((t) => t.id);
    // Undo puts each back in the category it came from: one change per category
    const from = new Map<string, string[]>();
    for (const t of chosen) {
      if (t.categoryId == null || t.categoryId === categoryId) continue;
      from.set(t.categoryId, [...(from.get(t.categoryId) ?? []), t.id]);
    }
    change({ op: 'recategoriseTransactions', ids, categoryId });
    done();
    showUndo(
      `Moved ${transactionsText(ids.length)} to ${categoryName(categories ?? [], categoryId)}`,
      () =>
        change(
          ...[...from].map(
            ([back, those]): LedgerChange => ({
              op: 'recategoriseTransactions',
              ids: those,
              categoryId: back,
            }),
          ),
        ),
    );
  };

  const remove = () => {
    const gone = chosen;
    change({ op: 'removeTransactions', ids: gone.map((t) => t.id) });
    done();
    // Undo adds each again, with its own id
    showUndo(`Deleted ${transactionsText(gone.length)}`, () =>
      change(
        ...gone.map(
          ({ createdAt: _at, ...t }): LedgerChange => ({
            op: 'addTransaction',
            transaction: t,
          }),
        ),
      ),
    );
  };

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <Button
          variant="subtle"
          color="gray"
          size="compact-md"
          className={classes.back}
          leftSection={<CaretLeft size={16} />}
          onClick={() => goUp('')}
        >
          Home
        </Button>
        <h1 className={classes.title}>Search transactions</h1>
      </header>

      <section
        className={classes.filters}
        aria-label="Filters"
      >
        <TextInput
          type="search"
          label="Search"
          placeholder="Payee, note, category or amount"
          leftSection={<MagnifyingGlass size={16} />}
          maxLength={MAX_SEARCH_TEXT}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <div className={classes.filterRow}>
          <NativeSelect
            label="Account"
            value={filters.account ?? ''}
            onChange={(e) => filter('account')(e.currentTarget.value)}
            data={[
              { value: '', label: 'All accounts' },
              ...(accounts ?? []).map((a) => ({
                value: a.id,
                label: a.archived ? `${a.name} (archived)` : a.name,
              })),
            ]}
          />
          <NativeSelect
            label="Category"
            value={filters.category ?? ''}
            onChange={(e) => filter('category')(e.currentTarget.value)}
            data={[
              { value: '', label: 'All categories' },
              ...(tree == null
                ? []
                : [
                    { group: 'Spending', items: categoryOptions(tree.listed.expense) },
                    { group: 'Income', items: categoryOptions(tree.listed.income) },
                  ]),
            ]}
          />
        </div>
        <div className={classes.filterRow}>
          <TextInput
            type="date"
            label="From"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(e) => filter('from')(e.currentTarget.value)}
          />
          <TextInput
            type="date"
            label="To"
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            onChange={(e) => filter('to')(e.currentTarget.value)}
          />
        </div>
      </section>

      {shown != null && shown.length > 0 && (
        <div className={selected == null ? classes.tools : `${classes.tools} ${classes.selecting}`}>
          {selected == null ? (
            <Button
              variant="default"
              size="compact-md"
              onClick={() => setSelected(new Set())}
            >
              Select
            </Button>
          ) : (
            <>
              <span
                className={classes.count}
                aria-live="polite"
              >
                {selected.size} selected
              </span>
              <Button
                variant="subtle"
                size="compact-md"
                onClick={() => void selectAll()}
              >
                Select all
              </Button>
              <span className={classes.actions}>
                <Button
                  size="compact-md"
                  disabled={chosen.length === 0}
                  onClick={() => start('move')}
                >
                  Change category
                </Button>
                <Button
                  size="compact-md"
                  color="red"
                  variant="light"
                  disabled={chosen.length === 0}
                  onClick={() => start('delete')}
                >
                  Delete
                </Button>
                <Button
                  size="compact-md"
                  variant="subtle"
                  color="gray"
                  onClick={() => setSelected(null)}
                >
                  Cancel
                </Button>
              </span>
            </>
          )}
        </div>
      )}

      <Results
        found={found}
        accounts={accounts}
        categories={categories}
        selected={selected}
        onOpen={(transaction) => setEntry({ transaction })}
        onToggle={toggle}
        onLongPress={(id) => setSelected(new Set([id]))}
      />

      <BulkDialogs
        action={action}
        chosen={chosen}
        categories={categories ?? []}
        onMove={move}
        onDelete={remove}
        onClose={() => setAction(null)}
      />
      <EntrySheet
        open={entry}
        onClose={() => setEntry(null)}
      />
    </div>
  );
}

/** What a transaction is, as found: its category (or the accounts of a transfer), and the rest */
function rowText(t: Transaction, accounts: Account[], categories: Category[]) {
  const account = accounts.find((a) => a.id === t.accountId);
  const title = transactionSummary(t, accounts, categories);
  const detail = [t.payee, t.note, t.kind === 'transfer' ? null : account?.name]
    .filter(Boolean)
    .join(' · ');
  const money = formatMoney(t.amountCents, account?.currency ?? 'MYR');
  const amount = t.kind === 'expense' ? `−${money}` : t.kind === 'income' ? `+${money}` : money;
  return { title, detail, amount, name: [title, detail, amount].filter(Boolean).join(', ') };
}

function Results({
  found,
  accounts,
  categories,
  selected,
  onOpen,
  onToggle,
  onLongPress,
}: {
  found: ReturnType<typeof useSearch>;
  /** Null until loaded: what's found is shown with the names of both */
  accounts: Account[] | null;
  categories: Category[] | null;
  selected: Set<string> | null;
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

  const { transactions, failed, retry, hasMore, loadMore, loadingMore } = found;
  if (transactions == null || accounts == null || categories == null) {
    return failed ? (
      <div className={classes.card}>
        <p className={classes.muted}>Couldn't search. Check the connection and try again.</p>
        <Button
          variant="default"
          onClick={retry}
        >
          Try again
        </Button>
      </div>
    ) : (
      <Loading
        label="Searching"
        className={classes.list}
      >
        {Array.from({ length: LOADING_ROWS }, (_, i) => (
          <div
            key={i}
            className={classes.row}
          >
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
              width={72}
              height={16}
            />
          </div>
        ))}
      </Loading>
    );
  }

  if (transactions.length === 0) {
    return (
      <section
        className={classes.card}
        aria-label="Results"
      >
        <p className={classes.emptyTitle}>No transactions match</p>
        <p className={classes.muted}>Try other words, or fewer filters.</p>
      </section>
    );
  }

  // Grouped by day, newest first, as they come
  const days: { day: string; transactions: Transaction[] }[] = [];
  for (const t of transactions) {
    const last = days.at(-1);
    if (last?.day === t.date) last.transactions.push(t);
    else days.push({ day: t.date, transactions: [t] });
  }

  return (
    <section
      className={classes.days}
      aria-label="Results"
    >
      {days.map(({ day, transactions: onDay }) => (
        <div
          key={day}
          className={classes.day}
        >
          <h2 className={classes.dayTitle}>{dayHeading(day)}</h2>
          <ul
            className={classes.list}
            aria-label={dayHeading(day)}
          >
            {onDay.map((t) => {
              const { title, detail, amount, name } = rowText(t, accounts, categories);
              const body = (
                <>
                  <span className={classes.rowText}>
                    <span className={classes.name}>{title}</span>
                    {detail && <span className={classes.detail}>{detail}</span>}
                  </span>
                  <span
                    className={
                      t.kind === 'income' ? `${classes.amount} ${classes.income}` : classes.amount
                    }
                  >
                    {amount}
                  </span>
                </>
              );
              return (
                <li key={t.id}>
                  {selected == null ? (
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
                      {body}
                    </button>
                  ) : (
                    <label
                      className={`${classes.row} ${classes.tickRow}`}
                      // A fresh press, so the next tick is never mistaken for a long press's release
                      onPointerDown={() => (press.current.fired = false)}
                    >
                      <input
                        type="checkbox"
                        className={classes.tick}
                        aria-label={name}
                        checked={selected.has(t.id)}
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
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {hasMore && (
        <Button
          variant="default"
          className={classes.loadMore}
          loading={loadingMore}
          onClick={loadMore}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
