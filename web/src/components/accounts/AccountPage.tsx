import { Button } from '@mantine/core';
import { CaretLeft, PencilSimple, Receipt } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Account, Category, Transaction } from '@shared/api';
import { balanceEffect } from '@shared/ledger';
import { goUp } from '../../hooks/useRoute';
import { useAccountTransactions, useAccounts, useCategories } from '../../ledger/useLedger';
import { dayHeading } from '../../utils/date-input';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import { signedMoney, transactionTitle } from '../entry/entry-text';
import Fab from '../ui/Fab';
import Skeleton, { Loading } from '../ui/Skeleton';
import AccountForm from './AccountForm';
import { KIND_LABELS, balanceText } from './account-text';
import KindIcon from './KindIcon';
import classes from './AccountPage.module.css';

/** Placeholder rows while the transactions load */
const LOADING_ROWS = 5;

// One account's page: its name, kind and balance, and its transactions newest first,
// grouped by day. Tap one to change or delete it; Add puts a new one on this account,
// and Edit changes or archives the account itself.
export default function AccountPage({ id }: { id: string }) {
  const { accounts, failed, retry } = useAccounts();
  const { categories } = useCategories();
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<OpenEntry | null>(null);
  const account = accounts?.find((a) => a.id === id);

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
                width={160}
                height={26}
              />
              <Skeleton
                width={64}
                height={14}
              />
              <Skeleton
                width={140}
                height={30}
              />
            </Loading>
          )
        ) : account == null ? (
          <div className={classes.card}>
            <h1 className={classes.title}>Account not found</h1>
            <p className={classes.muted}>It may have been added on another device and not saved.</p>
          </div>
        ) : (
          <Summary
            account={account}
            onEdit={() => setEditing(true)}
          />
        )}
      </header>

      {account != null && (
        <Transactions
          account={account}
          accounts={accounts ?? []}
          categories={categories ?? []}
          onOpen={(transaction) => setEntry({ transaction })}
        />
      )}

      {account != null && !account.archived && (
        <Fab
          label="Add"
          onClick={() => setEntry({ transaction: null, accountId: account.id })}
        />
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

function Summary({ account, onEdit }: { account: Account; onEdit: () => void }) {
  return (
    <div className={classes.summary}>
      <div className={classes.titleRow}>
        <span className={classes.icon}>
          <KindIcon kind={account.kind} />
        </span>
        <div className={classes.titleText}>
          <h1 className={classes.title}>{account.name}</h1>
          <span className={classes.kind}>
            {KIND_LABELS[account.kind]}
            {account.archived && ', archived'}
          </span>
        </div>
        <Button
          variant="default"
          size="compact-md"
          leftSection={<PencilSimple size={16} />}
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
      <p
        className={
          account.kind !== 'card' && account.balanceCents < 0
            ? `${classes.balance} ${classes.negative}`
            : classes.balance
        }
        aria-label={`Balance ${balanceText(account)}`}
      >
        {balanceText(account)}
      </p>
    </div>
  );
}

function Transactions({
  account,
  accounts,
  categories,
  onOpen,
}: {
  account: Account;
  accounts: Account[];
  categories: Category[];
  onOpen: (transaction: Transaction) => void;
}) {
  const { transactions, failed, retry, hasMore, loadMore, loadingMore } = useAccountTransactions(
    account.id,
  );

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
      <Loading
        label="Loading the transactions"
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
            className={classes.list}
            aria-label={dayHeading(day)}
          >
            {onDay.map((t) => {
              const name = transactionTitle(t, account.id, accounts, categories);
              const detail = [t.payee, t.note].filter(Boolean).join(' · ');
              const amount = signedMoney(t, account.id, account.currency);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={classes.row}
                    aria-label={[name, detail, amount].filter(Boolean).join(', ')}
                    onClick={() => onOpen(t)}
                  >
                    <span className={classes.rowText}>
                      <span className={classes.name}>{name}</span>
                      {detail && <span className={classes.detail}>{detail}</span>}
                    </span>
                    <span
                      className={
                        balanceEffect(t, account.id) > 0
                          ? `${classes.amount} ${classes.income}`
                          : classes.amount
                      }
                    >
                      {amount}
                    </span>
                  </button>
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
