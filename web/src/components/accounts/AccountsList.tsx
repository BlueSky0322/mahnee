import { Button } from '@mantine/core';
import { useCurrency } from '../../profile/ProfileContext';
import { AccountsIcon, ForwardIcon, PlusIcon } from '../ui/icons';
import type { MouseEvent } from 'react';
import { useState } from 'react';
import type { Account } from '@shared/api';
import { navigate } from '../../hooks/useRoute';
import { useAccounts } from '../../ledger/useLedger';
import Skeleton, { Loading } from '../ui/Skeleton';
import Tile from '../ui/Tile';
import AccountForm from './AccountForm';
import {
  accountTotals,
  groupText,
  kindLine,
  listBalance,
  listBalanceText,
  signedMoneyText,
  totalsLine,
} from './account-text';
import KindIcon from './KindIcon';
import classes from './AccountsPage.module.css';

/** Placeholder rows while the accounts load */
const LOADING_ROWS = 3;

// Accounts' list (R-Accounts, R-Desk-Accounts): all together, what's in accounts and what's
// owed, then cash, banks and e-wallets and the cards, each with its total, and the archived
// ones behind "Archived · N". On a phone a row opens the account's own page; on a computer
// (`selected`) it opens beside the list, in the list's place in history.
export default function AccountsList({ selected }: { selected?: string | null }) {
  const homeCurrency = useCurrency();
  const desktop = selected !== undefined;
  const { accounts, failed, retry } = useAccounts();
  const [adding, setAdding] = useState(false);
  // Shut until opened, except that it's open while the account beside it is an archived one
  const [toggled, setToggled] = useState<boolean | null>(null);
  const selectedArchived = accounts?.some((a) => a.id === selected && a.archived) ?? false;
  const showArchived = toggled ?? selectedArchived;

  const running = accounts?.filter((a) => !a.archived) ?? [];
  const archived = accounts?.filter((a) => a.archived) ?? [];
  const have = running.filter((a) => a.kind !== 'card');
  const cards = running.filter((a) => a.kind === 'card');
  const currency = running[0]?.currency ?? homeCurrency;
  const totals = accountTotals(running);
  const open = (account: Account) => (e: MouseEvent) => {
    e.preventDefault();
    navigate(`?account=${account.id}`, { replace: desktop });
  };
  const rowsOf = (list: Account[], muted = false) => (
    <ul className={classes.list}>
      {list.map((account) => (
        <li key={account.id}>
          <Row
            account={account}
            current={account.id === selected}
            muted={muted}
            desktop={desktop}
            onClick={open(account)}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className={classes.listPane}>
      <header className={classes.header}>
        <div className={classes.heading}>
          <h1 className={classes.title}>Accounts</h1>
          {desktop && running.length > 0 && (
            <div
              role="group"
              aria-label="All together"
              className={classes.deskTotals}
            >
              <p className={classes.soft}>
                <span className={`${classes.inkFigure} sf-tabular`}>
                  {signedMoneyText(totals.togetherCents, currency)}
                </span>{' '}
                all together · {totalsLine(totals, currency)}
              </p>
            </div>
          )}
        </div>
        {accounts != null && accounts.length > 0 && (
          <Button
            variant={desktop ? 'default' : 'light'}
            size="xs"
            className={`${classes.addAccount} ${classes.small}`}
            leftSection={desktop ? undefined : <PlusIcon size={16} />}
            aria-label={desktop ? undefined : 'Add account'}
            onClick={() => setAdding(true)}
          >
            {desktop ? 'Add account' : 'Account'}
          </Button>
        )}
      </header>

      {!desktop && running.length > 0 && (
        <div
          role="group"
          aria-label="All together"
          className={classes.totals}
        >
          <p className={classes.eyebrow}>All together</p>
          <p className={`${classes.together} sf-tabular`}>
            {signedMoneyText(totals.togetherCents, currency)}
          </p>
          <p className={classes.soft}>{totalsLine(totals, currency)}</p>
        </div>
      )}

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
            className={classes.groupCard}
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
                <span className={classes.rowMain}>
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
                  width={80}
                  height={16}
                />
              </div>
            ))}
          </Loading>
        )
      ) : running.length === 0 && archived.length === 0 ? (
        <div className={classes.card}>
          <span className={classes.emptyIcon}>
            <AccountsIcon size={28} />
          </span>
          <p className={classes.emptyTitle}>Add your first account</p>
          <p className={classes.muted}>
            Cash, bank accounts, cards and e-wallets: add each place your money is, and what's in it
            now.
          </p>
          <Button
            leftSection={<PlusIcon size={16} />}
            onClick={() => setAdding(true)}
          >
            Add account
          </Button>
        </div>
      ) : (
        <div
          className={desktop ? classes.deskList : classes.groups}
          aria-label={desktop ? 'Your accounts' : undefined}
          role={desktop ? 'region' : undefined}
        >
          {have.length > 0 && (
            <section
              aria-labelledby="accounts-have"
              className={classes.group}
            >
              <div className={classes.groupHead}>
                <h2
                  id="accounts-have"
                  className={classes.eyebrow}
                >
                  Cash, banks and e-wallets
                </h2>
                <span className={`${classes.groupTotal} sf-tabular`}>
                  {groupText('have', totals.haveCents, currency)}
                </span>
              </div>
              <div className={classes.groupCard}>{rowsOf(have)}</div>
            </section>
          )}
          {cards.length > 0 && (
            <section
              aria-labelledby="accounts-cards"
              className={classes.group}
            >
              <div className={classes.groupHead}>
                <h2
                  id="accounts-cards"
                  className={classes.eyebrow}
                >
                  Cards
                </h2>
                <span className={`${classes.groupTotal} sf-tabular`}>
                  {groupText('owed', totals.owedCents, currency)}
                </span>
              </div>
              <div className={classes.groupCard}>{rowsOf(cards)}</div>
            </section>
          )}
          {archived.length > 0 && (
            <section
              aria-label="Archived accounts"
              className={classes.group}
            >
              <button
                type="button"
                className={classes.archivedToggle}
                aria-expanded={showArchived}
                onClick={() => setToggled(!showArchived)}
              >
                <ForwardIcon
                  size={14}
                  aria-hidden
                  className={classes.caret}
                />
                Archived · {archived.length}
              </button>
              {showArchived && <div className={classes.groupCard}>{rowsOf(archived, true)}</div>}
            </section>
          )}
        </div>
      )}

      <AccountForm
        open={adding ? { account: null } : null}
        count={accounts?.length ?? 0}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}

/**
 * One account: its kind's tile, name, kind (and the day it was archived) and balance. On a
 * computer the list is plainer (R-Desk-Accounts): no tile, and a card's "owed" on the same
 * line as the amount.
 */
function Row({
  account,
  current,
  muted,
  desktop,
  onClick,
}: {
  account: Account;
  current: boolean;
  muted: boolean;
  desktop: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const kind = kindLine(account);
  const { amount, note } = listBalance(account);
  return (
    <a
      href={`?account=${account.id}`}
      className={classes.row}
      data-muted={muted || undefined}
      aria-current={current ? 'page' : undefined}
      aria-label={`${account.name}, ${kind}, ${listBalanceText(account)}`}
      onClick={onClick}
    >
      {!desktop && (
        <Tile>
          <KindIcon
            kind={account.kind}
            size={18}
          />
        </Tile>
      )}
      <span className={classes.rowMain}>
        <span className={classes.rowTitle}>{account.name}</span>
        <span className={classes.rowSub}>{kind}</span>
      </span>
      {desktop ? (
        <span className={`${classes.rowAmount} sf-tabular`}>{listBalanceText(account)}</span>
      ) : (
        <span className={classes.rowEnd}>
          <span className={`${classes.rowAmount} sf-tabular`}>{amount}</span>
          {note != null && <span className={classes.rowNote}>{note}</span>}
        </span>
      )}
    </a>
  );
}
