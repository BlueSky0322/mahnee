import { Button } from '@mantine/core';
import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import type { Account, Category, MonthSummary, Transaction, WeekStart } from '@shared/api';
import type { SearchQuery } from '@shared/search';
import { glanceDays, againstMedian, biggestSpend, byDay, spentSoFar } from '../../ledger/glance';
import { holdsFrom } from '../../ledger/history';
import { useSearch } from '../../ledger/useLedger';
import { isOffline } from '../../offline/network';
import { useCurrency } from '../../profile/ProfileContext';
import { dayHeading, monthHeading } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import { fullDay, headlineAmount, onDeviceLine, shortDay } from '../activity/activity-text';
import { categoryName } from '../common/category-name';
import EntrySheet, { type OpenEntry } from '../entry/EntrySheet';
import Skeleton from '../ui/Skeleton';
import classes from './Home.module.css';
import { medianText, signedMoney } from './home-text';
import PageLink from './PageLink';

/** The most entries Recent activity lists; See all has the rest */
const MAX_RECENT = 20;
/** The most entries read for the week's biggest before it's left as not known */
const MAX_READ = 1_000;
/** What's said where the device doesn't hold the days a figure needs */
const NOT_ON_DEVICE = "These days aren't on this device yet";

// A phone's Home at a glance (Home shows: Essentials; owner audit 2026-11-20): what was
// spent so far this month, the day against the median daily spend (tap for the baseline),
// the week's biggest expense (tap to open it) and the last 7 days, newest first, by day.
// An earlier month is seen from its last day, with its dates in place of "today" and "this
// week". Spending is expenses alone; income and transfers are listed but never counted.
// The month's figures come from its totals and the entries from a search of those days,
// both with the changes still to send on top, so an entry made offline moves them all at
// once. Offline, where the device doesn't hold every day of the week, it says so rather
// than claiming nothing was spent or a biggest.
export default function AtAGlance({
  month,
  isCurrent,
  firstDay,
  day,
  summary,
  failedMonth,
  monthEndCents,
  weekStart,
  accounts,
  categories,
}: {
  month: string;
  isCurrent: boolean;
  firstDay: string;
  /** Today, or an earlier month's last day */
  day: string;
  /** The month's totals; null until loaded */
  summary: MonthSummary | null;
  /** Shown in place of the month's figures when its totals couldn't be had */
  failedMonth: ReactNode;
  /** Where this month is expected to end; null for an earlier month or until known */
  monthEndCents: number | null;
  weekStart: WeekStart;
  /** Null until known: the entries wait for them, so no account goes unnamed */
  accounts: readonly Account[] | null;
  categories: readonly Category[];
}) {
  const currency = useCurrency();
  const [open, setOpen] = useState<OpenEntry | null>(null);
  const days = glanceDays(day, firstDay, weekStart);
  const query: SearchQuery = {
    q: '',
    account: null,
    category: null,
    from: days.recentFrom,
    to: day,
    kinds: null,
  };
  const found = useSearch(query);
  const { transactions, hasMore, loadingMore, loadMore } = found;
  // The week's biggest needs every entry of it: read on until all are in
  const readOn = hasMore && !loadingMore && (transactions?.length ?? 0) < MAX_READ;
  useEffect(() => {
    if (readOn) loadMore();
  }, [readOn, loadMore]);

  const offlineFailed = transactions == null && found.failed && isOffline();
  const holds = (from: string) =>
    !offlineFailed && (found.onDevice == null || holdsFrom(found.onDevice, from));
  const openEntry = (transaction: Transaction) => setOpen({ transaction });

  return (
    <>
      {failedMonth ?? (
        <SpentSoFar
          month={month}
          isCurrent={isCurrent}
          firstDay={firstDay}
          day={day}
          summary={summary}
        />
      )}
      {monthEndCents != null && (
        // The month end, a quiet line: the full Home has its breakdown
        <PageLink
          href="?plan=scheduled"
          className={classes.glanceMonthEnd}
        >
          Expected at month end{' '}
          <span className={classes.num}>{signedMoney(monthEndCents, currency)}</span>
        </PageLink>
      )}
      {failedMonth != null ? null : summary == null ? (
        <Skeleton
          width="100%"
          height={44}
        />
      ) : (
        <TodayAgainst
          summary={summary}
          firstDay={firstDay}
          day={day}
          isCurrent={isCurrent}
        />
      )}
      <Biggest
        label={
          isCurrent
            ? 'Biggest spend this week'
            : `Biggest spend ${shortDay(days.weekFrom, day)} to ${shortDay(day, day)}`
        }
        isCurrent={isCurrent}
        state={
          !holds(days.weekFrom)
            ? 'unknown'
            : transactions == null || readOn || loadingMore
              ? 'loading'
              : hasMore
                ? // More than MAX_READ entries in a week: not all of it read
                  'unknown'
                : biggestSpend(transactions, days.weekFrom, day)
        }
        today={day}
        currency={currency}
        categories={categories}
        onOpen={openEntry}
      />
      <Recent
        label={
          isCurrent ? 'Last 7 days' : `${shortDay(days.recentFrom, day)} to ${shortDay(day, day)}`
        }
        seeAll={`?activity&kind=all&from=${days.recentFrom}&to=${day}`}
        found={found}
        offlineFailed={offlineFailed}
        partial={
          found.onDevice != null && !holdsFrom(found.onDevice, days.recentFrom)
            ? onDeviceLine(found.onDevice, { from: days.recentFrom, to: day }, day)
            : null
        }
        from={days.recentFrom}
        day={day}
        currency={currency}
        accounts={accounts}
        categories={categories}
        onOpen={openEntry}
      />
      <EntrySheet
        open={open}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

/** "Spent so far · RM 668.50", opening those expenses in Activity */
function SpentSoFar({
  month,
  isCurrent,
  firstDay,
  day,
  summary,
}: {
  month: string;
  isCurrent: boolean;
  firstDay: string;
  day: string;
  summary: MonthSummary | null;
}) {
  const currency = useCurrency();
  const label = isCurrent ? 'Spent so far' : `Spent in ${monthHeading(month, { short: true })}`;
  return (
    <PageLink
      href={`?activity&kind=expense&from=${firstDay}&to=${day}`}
      push
      className={classes.spentSoFar}
    >
      <span className={classes.eyebrow}>{label}</span>{' '}
      {summary == null ? (
        <Skeleton
          width={200}
          height={40}
        />
      ) : (
        <span className={classes.heroFigure}>
          {formatMoney(spentSoFar(summary.spentByDay, firstDay, day), currency)}
        </span>
      )}
    </PageLink>
  );
}

/** "Today RM 57.00 · RM 18.00 above median", with the median and its days a tap away */
function TodayAgainst({
  summary,
  firstDay,
  day,
  isCurrent,
}: {
  summary: MonthSummary;
  firstDay: string;
  day: string;
  isCurrent: boolean;
}) {
  const currency = useCurrency();
  const baselineId = useId();
  const [shown, setShown] = useState(false);
  const against = againstMedian(summary.spentByDay, firstDay, summary.lastDay, day);
  return (
    <div className={classes.glanceRow}>
      <button
        type="button"
        className={classes.glanceButton}
        aria-expanded={shown}
        aria-controls={baselineId}
        onClick={() => setShown((v) => !v)}
      >
        <span className={classes.glanceLabel}>{isCurrent ? 'Today' : shortDay(day, day)}</span>{' '}
        <span className={classes.glanceFigure}>{formatMoney(against.cents, currency)}</span>{' '}
        <span className={classes.glanceAside}>
          {`· ${medianText(against.differenceCents, currency)}`}
        </span>
      </button>
      <p
        id={baselineId}
        className={classes.glanceLine}
        hidden={!shown}
      >
        {`Median daily spend ${formatMoney(against.medianCents, currency)} · ${shortDay(firstDay, day)} to ${shortDay(day, day)}, days with nothing spent counted`}
      </p>
    </div>
  );
}

/** The week's largest expense, opening it; or that there was none, or isn't known */
function Biggest({
  label,
  isCurrent,
  state,
  today,
  currency,
  categories,
  onOpen,
}: {
  label: string;
  isCurrent: boolean;
  state: Transaction | null | 'loading' | 'unknown';
  today: string;
  currency: string;
  categories: readonly Category[];
  onOpen: (t: Transaction) => void;
}) {
  const labelId = useId();
  let body;
  if (state === 'loading') {
    body = (
      <Skeleton
        width="60%"
        height={22}
      />
    );
  } else if (state === 'unknown') {
    body = <span className={classes.glanceLine}>{NOT_ON_DEVICE}</span>;
  } else if (state == null) {
    body = (
      <span className={classes.glanceLine}>
        {isCurrent ? 'Nothing spent this week' : 'Nothing spent'}
      </span>
    );
  } else {
    body = (
      <button
        type="button"
        className={classes.glanceButton}
        onClick={() => onOpen(state)}
      >
        <span className={classes.glanceFigure}>{formatMoney(state.amountCents, currency)}</span>{' '}
        <span className={classes.glanceAside}>
          {`${state.payee ?? state.note ?? categoryName(categories, state.categoryId)} · ${fullDay(state.date, today)}`}
        </span>
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={classes.glanceRow}
    >
      <span
        id={labelId}
        className={classes.glanceLabel}
      >
        {label}
      </span>{' '}
      {body}
    </div>
  );
}

/** "Recent activity": the last few days' entries, newest first, by day */
function Recent({
  label,
  seeAll,
  found,
  offlineFailed,
  partial,
  from,
  day,
  currency,
  accounts,
  categories,
  onOpen,
}: {
  label: string;
  seeAll: string;
  found: ReturnType<typeof useSearch>;
  offlineFailed: boolean;
  /** What the device holds of these days, offline, when it isn't all of them */
  partial: string | null;
  from: string;
  day: string;
  currency: string;
  accounts: readonly Account[] | null;
  categories: readonly Category[];
  onOpen: (t: Transaction) => void;
}) {
  const titleId = useId();
  const listed = found.transactions?.slice(0, MAX_RECENT) ?? [];
  const groups = byDay(listed, from, day);
  const accountName = (id: string | null) =>
    accounts?.find((a) => a.id === id)?.name ?? 'another account';

  let body;
  if (found.transactions == null || accounts == null) {
    body = offlineFailed ? (
      <p className={classes.soft}>{"Entries for these days aren't on this device yet."}</p>
    ) : found.failed ? (
      <div className={classes.failedInline}>
        <p className={classes.soft}>Couldn&apos;t load these days.</p>
        <Button
          variant="default"
          onClick={found.retry}
        >
          Try again
        </Button>
      </div>
    ) : (
      <Skeleton
        width="100%"
        height={120}
      />
    );
  } else if (groups.length === 0) {
    body = partial == null && <p className={classes.soft}>No entries in these days.</p>;
  } else {
    body = groups.map((group) => (
      <div
        key={group.date}
        className={classes.recentDay}
      >
        <p
          className={classes.recentDate}
          aria-hidden
        >
          {dayHeading(group.date)}
        </p>
        <ul
          aria-label={dayHeading(group.date)}
          className={classes.recentList}
        >
          {group.entries.map((t) => {
            const what =
              t.kind === 'transfer'
                ? `${accountName(t.accountId)} to ${accountName(t.toAccountId)}`
                : categoryName(categories, t.categoryId);
            const title = t.payee ?? t.note ?? (t.kind === 'transfer' ? 'Transfer' : what);
            const line =
              t.kind === 'transfer'
                ? title === 'Transfer'
                  ? what
                  : `Transfer · ${what}`
                : title === what
                  ? accountName(t.accountId)
                  : what;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={classes.recentRow}
                  onClick={() => onOpen(t)}
                >
                  <span className={classes.recentText}>
                    <b>{title}</b> <span>{line}</span>
                  </span>{' '}
                  <span
                    className={
                      t.kind === 'income'
                        ? `${classes.recentAmount} ${classes.pos}`
                        : classes.recentAmount
                    }
                  >
                    {headlineAmount(t, currency)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    ));
  }

  return (
    <section
      className={`${classes.card} ${classes.recent}`}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Recent activity
        </h2>
        <span className={classes.middle}>{label}</span>
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
    </section>
  );
}
