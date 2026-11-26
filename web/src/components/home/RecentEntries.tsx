import { Button } from '@mantine/core';
import { useId, useState } from 'react';
import type { Account, Category, Transaction } from '@shared/api';
import type { SearchQuery } from '@shared/search';
import { holdsFrom } from '../../ledger/history';
import { RECENT_ENTRIES } from '../../ledger/ledger';
import { useHomeRows } from '../../ledger/useLedger';
import { isOffline } from '../../offline/network';
import { useCurrency } from '../../profile/ProfileContext';
import { dayHeading, monthHeading } from '../../utils/date-input';
import { SIGNS, headlineAmount, onDeviceLine, rowText } from '../activity/activity-text';
import EntryTile from '../common/EntryTile';
import MainAmount from '../common/MainAmount';
import { amountWords, typedAmount } from '../common/typed-amount';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import { LoadingRows } from '../ui/Skeleton';
import classes from './Home.module.css';
import PageLink from './PageLink';

// A computer's Home, beside the calendar (owner request 2026-11-25): the newest entries
// across every account, newest first, each with its day, what it was, its category and
// account (a transfer's two accounts) and its amount, signed and coloured as Activity does.
// On this month they're the latest of all, so the newest show however the month began; on
// an earlier month, that month's last ones. A row opens the entry as Activity does on a
// computer too narrow for its editor beside it; See all opens Activity on the same entries.
// Only these few are asked for, and an entry added or changed here moves them at once.
export default function RecentEntries({
  month,
  isCurrent,
  firstDay,
  lastDay,
  today,
  accounts,
  categories,
}: {
  month: string;
  isCurrent: boolean;
  firstDay: string;
  lastDay: string;
  today: string;
  /** Null until known: the rows wait for them, so no account goes unnamed */
  accounts: readonly Account[] | null;
  categories: Category[];
}) {
  const titleId = useId();
  const currency = useCurrency();
  const [open, setOpen] = useState<OpenEntry | null>(null);
  const query: SearchQuery = {
    q: '',
    account: null,
    category: null,
    from: isCurrent ? null : firstDay,
    to: isCurrent ? null : lastDay,
    kinds: null,
  };
  const found = useHomeRows(query, { latest: true });
  const rows = found.transactions;
  const name = monthHeading(month, { short: true });
  const title = isCurrent ? 'Recent activity' : `Latest in ${name}`;
  const seeAll = isCurrent
    ? '?activity&kind=all&dates=all'
    : `?activity&kind=all&from=${firstDay}&to=${lastDay}`;
  // Offline, from a history that may not reach back to the oldest of these
  const partial =
    rows != null &&
    found.onDevice != null &&
    !holdsFrom(found.onDevice, rows.length >= RECENT_ENTRIES ? rows.at(-1)!.date : query.from)
      ? onDeviceLine(found.onDevice, { from: query.from, to: query.to }, today)
      : null;

  let body;
  if (rows == null || accounts == null) {
    body =
      found.failed && isOffline() ? (
        <p className={classes.soft}>{"Your entries aren't on this device yet."}</p>
      ) : found.failed ? (
        <div className={classes.failedInline}>
          <p className={classes.soft}>Couldn&apos;t load your latest entries.</p>
          <Button
            variant="default"
            onClick={found.retry}
          >
            Try again
          </Button>
        </div>
      ) : (
        <LoadingRows
          label="Loading recent activity"
          rows={4}
          className={classes.recentLoading}
        />
      );
  } else if (rows.length === 0) {
    body = partial == null && (
      <p className={classes.soft}>
        {isCurrent ? 'Nothing logged yet. New entry (N) adds one.' : `Nothing logged in ${name}.`}
      </p>
    );
  } else {
    body = (
      <ul className={classes.latestList}>
        {rows.map((t) => (
          <li key={t.id}>
            <LatestRow
              t={t}
              accounts={accounts}
              categories={categories}
              today={today}
              currency={currency}
              onOpen={() => setOpen({ transaction: t })}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section
      className={`${classes.card} ${classes.latest}`}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          {title}
        </h2>
        <PageLink
          href={seeAll}
          push
          className={classes.more}
        >
          See all
        </PageLink>
      </div>
      {partial != null && <p className={classes.glanceLine}>{partial}</p>}
      {body}
      <EntrySheet
        open={open}
        onClose={() => setOpen(null)}
      />
    </section>
  );
}

/** One entry: its tile, what it was over its category and account, its day and its amount */
function LatestRow({
  t,
  accounts,
  categories,
  today,
  currency,
  onOpen,
}: {
  t: Transaction;
  accounts: readonly Account[];
  categories: Category[];
  today: string;
  currency: string;
  onOpen: () => void;
}) {
  const { title, subtitle } = rowText(t, {
    accounts,
    categories,
    q: '',
    selecting: false,
    today,
  });
  const day = dayHeading(t.date);
  const shown = headlineAmount(t, currency);
  return (
    <button
      type="button"
      className={classes.latestRow}
      aria-label={`${title}, ${subtitle}, ${day}, ${amountWords(t, shown, SIGNS[t.kind], currency)}`}
      onClick={onOpen}
    >
      <EntryTile
        t={t}
        categories={categories}
      />
      <span className={classes.latestText}>
        <span className={classes.latestTitle}>{title}</span>
        <span className={classes.latestLine}>{subtitle}</span>
      </span>
      <span className={classes.latestDay}>{day}</span>
      <span
        className={classes.latestAmount}
        data-kind={t.kind}
      >
        {typedAmount(t, SIGNS[t.kind]) ?? shown}
        <MainAmount
          t={t}
          currency={currency}
        />
      </span>
    </button>
  );
}
