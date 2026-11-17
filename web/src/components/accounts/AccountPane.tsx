import { Button, TextInput } from '@mantine/core';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Account, Category, Transaction } from '@shared/api';
import { MAX_SEARCH_TEXT } from '@shared/search';
import {
  useAccountTransactions,
  useAccounts,
  useCategories,
  useSearch,
} from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { periodText, shortDay } from '../activity/activity-text';
import { periodMonthOf, periodOf, shiftMonth } from '@shared/period';
import { useMonthStart } from '../../ledger/month-start';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import { NewTag } from '../ui/Badge';
import Chip from '../ui/Chip';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import AccountForm from './AccountForm';
import { ArchivedNote, Balance, EntriesLoading, NoEntries } from './AccountPage';
import { useAccountActions } from './account-actions';
import { balancesAfter, entryRow, kindLine, listBalanceText, startedLine } from './account-text';
import classes from './AccountsPage.module.css';

/** The days the register shows: every one (null), or from and/or to, both included */
type Days = { from: string | null; to: string | null } | null;

/** The first and last days of the person's month `month` (2026-11) from `start` */
function monthDays(month: string, start: number) {
  const { firstDay, lastDay } = periodOf(month, start);
  return { from: firstDay, to: lastDay };
}

// An account open beside the list on a computer (R-Desk-Accounts, R-Desk-Accounts-Archived):
// its name, what it started at (or the day it was archived) and its balance; Add here,
// Transfer and Edit, or "Hidden when adding entries", Unarchive and Edit; a search of the
// account and "Any date"; and the register, newest first, with the balance after each entry
// worked back from the balance now. While searching or narrowed to some days the balances
// after can't be known, so that column goes. The search starts afresh on each account.
export default function AccountPane({ account }: { account: Account }) {
  const { accounts } = useAccounts();
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const [words, setWords] = useState('');
  const [days, setDays] = useState<Days>(null);
  const [picking, setPicking] = useState(false);
  const { addHere, transfer } = useAccountActions(account);
  const today = toDateInput(new Date());
  const start = useMonthStart();
  const q = words.trim();
  const daysLabel = days == null ? 'Any date' : periodText(days, today, start);

  return (
    <section
      className={classes.pane}
      aria-labelledby="account-pane-name"
    >
      <div className={classes.paneHead}>
        <div className={classes.paneTitle}>
          <h2
            id="account-pane-name"
            className={classes.paneName}
          >
            {account.name}
          </h2>
          <span className={classes.muted}>
            {account.archived ? kindLine(account) : startedLine(account)}
          </span>
          <Balance
            account={account}
            small
          />
        </div>
        <div className={classes.paneActions}>
          {account.archived ? (
            <ArchivedNote account={account} />
          ) : (
            <>
              <Button
                size="compact-md"
                onClick={addHere}
              >
                Add here
              </Button>
              <Button
                variant="light"
                size="compact-md"
                onClick={transfer}
              >
                Transfer
              </Button>
            </>
          )}
          <Button
            variant="light"
            size="compact-md"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        </div>
      </div>
      <div className={classes.paneTools}>
        <TextInput
          type="search"
          className={classes.paneSearch}
          aria-label="Search this account"
          placeholder="Search this account"
          leftSection={<MagnifyingGlass size={16} />}
          maxLength={MAX_SEARCH_TEXT}
          value={words}
          onChange={(e) => setWords(e.currentTarget.value)}
          autoComplete="off"
        />
        <Chip
          on={days != null}
          opens
          onClick={() => setPicking(true)}
        >
          {daysLabel}
        </Chip>
      </div>
      {q === '' && days == null ? (
        <Register
          account={account}
          accounts={accounts ?? []}
          onOpen={(transaction) => setEntry({ transaction })}
        />
      ) : (
        <Found
          account={account}
          accounts={accounts ?? []}
          q={q}
          days={days}
          onOpen={(transaction) => setEntry({ transaction })}
        />
      )}
      <PickDays
        opened={picking}
        days={days}
        today={today}
        onClose={() => setPicking(false)}
        onPick={(next) => {
          setDays(next);
          setPicking(false);
        }}
      />
      <EntrySheet
        open={entry}
        onClose={() => setEntry(null)}
      />
      <AccountForm
        open={editing ? { account } : null}
        count={accounts?.length ?? 0}
        onClose={() => setEditing(false)}
      />
    </section>
  );
}

/** Every entry, a page of 50 at a time, with the balance after each */
function Register({
  account,
  accounts,
  onOpen,
}: {
  account: Account;
  accounts: Account[];
  onOpen: (t: Transaction) => void;
}) {
  const { categories } = useCategories();
  const { transactions, failed, retry, hasMore, loadMore, loadingMore } = useAccountTransactions(
    account.id,
  );
  if (transactions == null) return failed ? <Failed retry={retry} /> : <EntriesLoading />;
  if (transactions.length === 0) return <NoEntries account={account} />;
  const after = balancesAfter(account.balanceCents, account.id, transactions);
  return (
    <>
      <Table
        account={account}
        accounts={accounts}
        categories={categories ?? []}
        transactions={transactions}
        after={after}
        onOpen={onOpen}
      />
      {hasMore && (
        <Button
          variant="light"
          className={classes.more}
          loading={loadingMore}
          onClick={loadMore}
        >
          Show 50 more
        </Button>
      )}
    </>
  );
}

/** What the search finds on this account, through the search API */
function Found({
  account,
  accounts,
  q,
  days,
  onOpen,
}: {
  account: Account;
  accounts: Account[];
  q: string;
  days: Days;
  onOpen: (t: Transaction) => void;
}) {
  const { categories } = useCategories();
  const { transactions, failed, retry, hasMore, loadMore, loadingMore } = useSearch({
    q,
    account: account.id,
    category: null,
    kinds: null,
    from: days?.from ?? null,
    to: days?.to ?? null,
  });
  if (transactions == null) return failed ? <Failed retry={retry} /> : <EntriesLoading />;
  if (transactions.length === 0) {
    return <p className={classes.nothing}>Nothing on this account matches.</p>;
  }
  return (
    <>
      <Table
        account={account}
        accounts={accounts}
        categories={categories ?? []}
        transactions={transactions}
        after={null}
        onOpen={onOpen}
      />
      {hasMore && (
        <Button
          variant="light"
          className={classes.more}
          loading={loadingMore}
          onClick={loadMore}
        >
          Load more
        </Button>
      )}
    </>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <div className={classes.card}>
      <p className={classes.muted}>Couldn't load the transactions.</p>
      <Button
        variant="default"
        onClick={retry}
      >
        Try again
      </Button>
    </div>
  );
}

function Table({
  account,
  accounts,
  categories,
  transactions,
  after,
  onOpen,
}: {
  account: Account;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  /** The balance after each, or null where it can't be known */
  after: number[] | null;
  onOpen: (t: Transaction) => void;
}) {
  const today = toDateInput(new Date());
  return (
    <div className={classes.tableWrap}>
      <table
        className={classes.table}
        aria-label="Transactions"
      >
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Payee or transfer</th>
            <th scope="col">Category</th>
            <th
              scope="col"
              className={classes.right}
            >
              Amount
            </th>
            {after != null && (
              <th
                scope="col"
                className={classes.right}
              >
                Balance after
                <NewTag />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t, i) => {
            const { title, subtitle, amount, incoming } = entryRow(
              t,
              account.id,
              accounts,
              categories,
            );
            return (
              <tr key={t.id}>
                <td className={classes.muted}>{shortDay(t.date, today)}</td>
                <td className={classes.payee}>
                  <button
                    type="button"
                    className={classes.payeeButton}
                    onClick={() => onOpen(t)}
                  >
                    {title}
                  </button>
                </td>
                <td className={classes.soft}>{subtitle}</td>
                <td
                  className={`${classes.right} ${classes.rowAmount} sf-tabular`}
                  data-incoming={(incoming && t.kind === 'income') || undefined}
                >
                  {amount}
                </td>
                {after != null && (
                  <td className={`${classes.right} ${classes.soft} sf-tabular`}>
                    {listBalanceText({ ...account, balanceCents: after[i] })}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Any date": every day, this month, last month, or days picked */
function PickDays({
  opened,
  days,
  today,
  onClose,
  onPick,
}: {
  opened: boolean;
  days: Days;
  today: string;
  onClose: () => void;
  onPick: (days: Days) => void;
}) {
  // The person's months (shared/period.ts)
  const start = useMonthStart();
  const month = periodMonthOf(today, start);
  const current = monthDays(month, start);
  const last = monthDays(shiftMonth(month, -1), start);
  const same = (a: Days, b: Days) => a?.from === b?.from && a?.to === b?.to;
  const own = days != null && !same(days, current) && !same(days, last);
  const [picking, setPicking] = useState(own);
  const [from, setFrom] = useState(own ? days.from ?? '' : '');
  const [to, setTo] = useState(own ? days.to ?? '' : '');
  const choices = [
    { label: 'Any date', on: !picking && days == null, pick: () => onPick(null) },
    { label: 'This month', on: !picking && same(days, current), pick: () => onPick(current) },
    { label: 'Last month', on: !picking && same(days, last), pick: () => onPick(last) },
    { label: 'Pick dates', on: picking, pick: () => setPicking(true) },
  ];
  return (
    <ResponsiveDialog
      opened={opened}
      onClose={onClose}
      title="When"
    >
      <div
        className={classes.choices}
        role="radiogroup"
      >
        {choices.map((c) => (
          <label
            key={c.label}
            className={classes.choice}
          >
            <input
              type="radio"
              name="account-days"
              checked={c.on}
              onChange={c.pick}
              onClick={c.on ? c.pick : undefined}
            />
            {c.label}
          </label>
        ))}
      </div>
      {picking && (
        <form
          className={classes.pickDates}
          onSubmit={(e) => {
            e.preventDefault();
            if (from === '' && to === '') return;
            onPick({ from: from || null, to: to || null });
          }}
        >
          <TextInput
            type="date"
            label="From"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
          <TextInput
            type="date"
            label="To"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.currentTarget.value)}
          />
          <Button
            type="submit"
            disabled={from === '' && to === ''}
          >
            Show these dates
          </Button>
        </form>
      )}
    </ResponsiveDialog>
  );
}
