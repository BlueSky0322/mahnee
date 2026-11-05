import { Button } from '@mantine/core';
import { CaretDown, CaretRight, Plus, Wallet } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Account } from '@shared/api';
import { useAccounts } from '../../ledger/useLedger';
import Skeleton, { Loading } from '../ui/Skeleton';
import AccountForm from './AccountForm';
import { KIND_LABELS, balanceText } from './account-text';
import KindIcon from './KindIcon';
import classes from './Accounts.module.css';

/** Placeholder rows while the accounts load */
const LOADING_ROWS = 3;

// The home page's list of accounts with their balances: tap one to change it, or add one
export default function AccountList() {
  const { accounts, failed, retry } = useAccounts();
  const [open, setOpen] = useState<{ account: Account | null } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const listed = accounts?.filter((a) => !a.archived) ?? [];
  const archived = accounts?.filter((a) => a.archived) ?? [];
  const add = () => setOpen({ account: null });

  return (
    <section
      className={classes.section}
      aria-labelledby="accounts-title"
    >
      <div className={classes.sectionHeader}>
        <h2
          id="accounts-title"
          className={classes.sectionTitle}
        >
          Accounts
        </h2>
        {listed.length > 0 && (
          <Button
            variant="subtle"
            size="compact-md"
            leftSection={<Plus size={16} />}
            onClick={add}
          >
            Add account
          </Button>
        )}
      </div>

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
            label="Loading your accounts"
            className={classes.list}
          >
            {Array.from({ length: LOADING_ROWS }, (_, i) => (
              <div
                key={i}
                className={classes.row}
              >
                <Skeleton
                  circle
                  width={40}
                  height={40}
                />
                <span className={classes.rowText}>
                  <Skeleton
                    width={120}
                    height={16}
                  />
                  <Skeleton
                    width={56}
                    height={12}
                  />
                </span>
                <Skeleton
                  width={88}
                  height={16}
                />
              </div>
            ))}
          </Loading>
        )
      ) : listed.length === 0 ? (
        <div className={classes.card}>
          <span className={classes.emptyIcon}>
            <Wallet size={28} />
          </span>
          <p className={classes.emptyTitle}>Add your first account</p>
          <p className={classes.muted}>
            Cash, bank accounts, cards and e-wallets: add each place your money is, and what's in it
            now.
          </p>
          <Button
            leftSection={<Plus size={16} />}
            onClick={add}
          >
            Add account
          </Button>
        </div>
      ) : (
        <Rows
          accounts={listed}
          onOpen={(account) => setOpen({ account })}
        />
      )}

      {archived.length > 0 && (
        <>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            className={classes.archivedToggle}
            leftSection={showArchived ? <CaretDown size={14} /> : <CaretRight size={14} />}
            aria-expanded={showArchived}
            onClick={() => setShowArchived((shown) => !shown)}
          >
            Archived ({archived.length})
          </Button>
          {showArchived && (
            <Rows
              accounts={archived}
              onOpen={(account) => setOpen({ account })}
              muted
            />
          )}
        </>
      )}

      <AccountForm
        open={open}
        count={accounts?.length ?? 0}
        onClose={() => setOpen(null)}
      />
    </section>
  );
}

function Rows({
  accounts,
  onOpen,
  muted,
}: {
  accounts: Account[];
  onOpen: (account: Account) => void;
  muted?: boolean;
}) {
  return (
    <ul className={muted ? `${classes.list} ${classes.mutedList}` : classes.list}>
      {accounts.map((account) => (
        <li key={account.id}>
          <button
            type="button"
            className={classes.row}
            aria-label={`${account.name}, ${KIND_LABELS[account.kind]}, ${balanceText(account)}`}
            onClick={() => onOpen(account)}
          >
            <span className={classes.icon}>
              <KindIcon kind={account.kind} />
            </span>
            <span className={classes.rowText}>
              <span className={classes.name}>{account.name}</span>
              <span className={classes.kind}>{KIND_LABELS[account.kind]}</span>
            </span>
            <span
              className={
                account.kind !== 'card' && account.balanceCents < 0
                  ? `${classes.balance} ${classes.negative}`
                  : classes.balance
              }
            >
              {balanceText(account)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
