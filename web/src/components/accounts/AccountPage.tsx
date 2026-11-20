import { Button } from '@mantine/core';
import { Receipt } from '@phosphor-icons/react';
import { PlusIcon, SearchIcon, TransferIcon } from '../ui/icons';
import { useState } from 'react';
import type { Account, Category, Transaction } from '@shared/api';
import { goUp } from '../../hooks/useRoute';
import { useAccountTransactions, useAccounts, useCategories } from '../../ledger/useLedger';
import { dayHeading } from '../../utils/date-input';
import EntryTile from '../common/EntryTile';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import Skeleton, { Loading } from '../ui/Skeleton';
import AccountForm from './AccountForm';
import { useAccountActions } from './account-actions';
import { balanceText, entryRow, kindLine } from './account-text';
import MainAmount from '../common/MainAmount';
import { amountWords, typedAmount } from '../common/typed-amount';
import classes from './AccountsPage.module.css';
import BackButton from '../ui/BackButton';

/** Placeholder rows while the transactions load */
const LOADING_ROWS = 5;

// One account's own page on a phone or tablet (R-Account, R-Account-Archived): Back to
// Accounts and Edit; its kind, name and balance; Add here, Transfer and Search, or for an
// archived one "Hidden when adding entries" and Unarchive; then its entries by day, newest
// first, each signed by what it did to this account's balance. Tap one to change it.
export default function AccountPage({ id }: { id: string }) {
  const { accounts, failed, retry } = useAccounts();
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const account = accounts?.find((a) => a.id === id);

  return (
    <div className={`${classes.page} ${classes.accountPage}`}>
      <header className={classes.pageHeader}>
        <BackButton onClick={() => goUp('?accounts')}>Accounts</BackButton>
        {account != null && (
          <Button
            variant="light"
            size="xs"
            className={classes.small}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
      </header>
      {accounts == null ? (
        failed ? (
          <div className={classes.card}>
            <p className={classes.muted}>Couldn't load your accounts.</p>
            <Button
              variant="default"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Loading
            label="Loading the account"
            className={classes.summary}
          >
            <Skeleton
              width={64}
              height={14}
            />
            <Skeleton
              width={160}
              height={26}
            />
            <Skeleton
              width={140}
              height={36}
            />
          </Loading>
        )
      ) : account == null ? (
        <NotFound />
      ) : (
        <>
          <section className={classes.summary}>
            <p className={classes.muted}>{kindLine(account)}</p>
            <h1 className={classes.accountName}>{account.name}</h1>
            <Balance account={account} />
          </section>
          <Actions account={account} />
          <Entries
            account={account}
            accounts={accounts}
            onOpen={(transaction) => setEntry({ transaction })}
          />
        </>
      )}

      <EntrySheet
        open={entry}
        onClose={() => setEntry(null)}
      />
      <AccountForm
        open={editing && account != null ? { account } : null}
        count={accounts?.length ?? 0}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}

export function NotFound({ beside = false }: { beside?: boolean }) {
  const Heading = beside ? 'h2' : 'h1';
  return (
    <div className={classes.card}>
      <Heading className={classes.accountName}>Account not found</Heading>
      <p className={classes.muted}>It may have been added on another device and not saved.</p>
    </div>
  );
}

/** The balance, read out with what it is: "Balance RM 61,600.00", "Balance RM 120.00 owed" */
export function Balance({ account, small }: { account: Account; small?: boolean }) {
  return (
    <p
      className={`${small ? classes.paneBalance : classes.balance} sf-tabular`}
      aria-label={`Balance ${balanceText(account)}`}
    >
      {balanceText(account)}
    </p>
  );
}

/** An archived account's note and Unarchive, in place of the actions */
export function ArchivedNote({ account }: { account: Account }) {
  const { unarchive } = useAccountActions(account);
  return (
    <div className={classes.archivedNote}>
      <span className={classes.soft}>Hidden when adding entries</span>
      <Button
        variant="default"
        size="xs"
        className={classes.small}
        onClick={unarchive}
      >
        Unarchive
      </Button>
    </div>
  );
}

function Actions({ account }: { account: Account }) {
  const { addHere, transfer, search } = useAccountActions(account);
  if (account.archived) return <ArchivedNote account={account} />;
  return (
    <div className={classes.actions}>
      <button
        type="button"
        className={classes.action}
        onClick={addHere}
      >
        <PlusIcon
          size={20}
          aria-hidden
        />
        Add here
      </button>
      <button
        type="button"
        className={classes.action}
        onClick={transfer}
      >
        <TransferIcon
          size={20}
          aria-hidden
        />
        Transfer
      </button>
      <button
        type="button"
        className={classes.action}
        onClick={search}
      >
        <SearchIcon
          size={20}
          aria-hidden
        />
        Search
      </button>
    </div>
  );
}

/** Nothing on the account yet */
export function NoEntries({ account }: { account: Account }) {
  return (
    <div className={classes.card}>
      <span className={classes.emptyIcon}>
        <Receipt size={28} />
      </span>
      <p className={classes.emptyTitle}>Nothing here yet</p>
      <p className={classes.muted}>
        {account.archived
          ? 'Bring the account back to add what you spend and receive.'
          : 'Add what you spend from this account and what comes into it.'}
      </p>
    </div>
  );
}

function Entries({
  account,
  accounts,
  onOpen,
}: {
  account: Account;
  accounts: Account[];
  onOpen: (transaction: Transaction) => void;
}) {
  const { categories } = useCategories();
  const { transactions, failed, retry, hasMore, loadMore, loadingMore, onDevice } =
    useAccountTransactions(account.id);

  if (transactions == null) {
    return failed ? (
      <div className={classes.card}>
        <p className={classes.muted}>Couldn't load the transactions.</p>
        <Button
          variant="default"
          onClick={retry}
        >
          Try again
        </Button>
      </div>
    ) : (
      <EntriesLoading />
    );
  }
  if (transactions.length === 0) return <NoEntries account={account} />;

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
      aria-label="Transactions"
    >
      {days.map(({ day, transactions: onDay }) => (
        <div
          key={day}
          className={classes.day}
        >
          <h2 className={classes.dayTitle}>{dayHeading(day)}</h2>
          <ul
            className={classes.groupCard}
            aria-label={dayHeading(day)}
          >
            {onDay.map((t) => (
              <li key={t.id}>
                <EntryRow
                  t={t}
                  account={account}
                  accounts={accounts}
                  categories={categories ?? []}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
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
      {!hasMore && onDevice?.complete === false && (
        <p className={classes.muted}>Older entries aren't on this device yet.</p>
      )}
    </section>
  );
}

function EntryRow({
  t,
  account,
  accounts,
  categories,
  onOpen,
}: {
  t: Transaction;
  account: Account;
  accounts: Account[];
  categories: Category[];
  onOpen: (transaction: Transaction) => void;
}) {
  const { title, subtitle, amount, incoming } = entryRow(t, account.id, accounts, categories);
  const currency = account.currency;
  return (
    <button
      type="button"
      className={classes.row}
      aria-label={`${title}, ${subtitle}, ${amountWords(t, amount, amount[0], currency)}`}
      onClick={() => onOpen(t)}
    >
      <EntryTile
        t={t}
        categories={categories}
      />
      <span className={classes.rowMain}>
        <span className={classes.rowTitle}>{title}</span>
        <span className={classes.rowSub}>{subtitle}</span>
      </span>
      <span
        className={`${classes.rowAmount} sf-tabular`}
        data-incoming={(incoming && t.kind === 'income') || undefined}
        data-kind={t.kind}
      >
        {typedAmount(t, amount[0]) ?? amount}
        <MainAmount
          t={t}
          currency={currency}
        />
      </span>
    </button>
  );
}

export function EntriesLoading() {
  return (
    <Loading
      label="Loading the transactions"
      className={classes.groupCard}
    >
      {Array.from({ length: LOADING_ROWS }, (_, i) => (
        <div
          key={i}
          className={classes.row}
        >
          <span className={classes.rowMain}>
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
