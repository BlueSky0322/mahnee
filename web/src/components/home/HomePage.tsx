import { Button } from '@mantine/core';
import { CaretLeft, CaretRight, MagnifyingGlass, Rows } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useState } from 'react';
import type { Account, Category, Ledger, MonthSummary, WeekStart } from '@shared/api';
import { OTHER_EXPENSE_ID, categoriesOrDefaults } from '@shared/categories';
import { DEFAULT_CURRENCY, FIRST_DAY } from '@shared/ledger';
import { periodDay } from '@shared/period';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { ALL_EXPENSES, ALL_INCOME, navigate } from '../../hooks/useRoute';
import { budgetLines } from '../../ledger/budgets';
import { comingUp, monthEndForecast, nextPay } from '../../ledger/forecast';
import { useKnownMonthStart, useMonths } from '../../ledger/month-start';
import { useAccounts, useMonthSummary, useWholeLedger } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { addMonths, monthHeading } from '../../utils/date-input';
import { balanceText } from '../accounts/account-text';
import Freshness from '../common/Freshness';
import ThemeToggle from '../common/ThemeToggle';
import YouLink from '../common/YouLink';
import Skeleton, { Loading } from '../ui/Skeleton';
import type { ComingUpRow } from './ComingUp';
import ComingUp from './ComingUp';
import DayByDay, { type DueOnDay } from './DayByDay';
import DueItems from './DueItems';
import FirstRun from './FirstRun';
import GettingStarted, { type StartedSteps } from './GettingStarted';
import { isStartedHidden } from './getting-started';
import classes from './Home.module.css';
import HomeBudgets from './HomeBudgets';
import {
  expensesLine,
  heroLine,
  incomeLine,
  runningFast,
  signedMoney,
  tidyText,
} from './home-text';
import PageLink from './PageLink';
import { recurringName } from './recurring-text';

/** The earliest month a transaction can be in */
const FIRST_MONTH = FIRST_DAY.slice(0, 7);
/** How many scheduled items Coming up lists */
const COMING_UP = 3;

/** Home's address for `month`: this month's (`current`) names none */
const homeAddress = (month: string, current: string) => (month >= current ? '' : `?month=${month}`);

// The first screen, at a glance: where the month will land with the sum under it, spent so far and
// what came in (each opening its last 12 months), what needs you (what's due now, Tidy up, Coming
// up), a day by day calendar and the budgets with a marker for today. The full lists live in
// Activity, Plan and Accounts. An earlier month (`month`, ?month=2026-10; null for this one) says
// what it left instead, with its days and budgets. Until the first account is added, the first run
// asks where the money is kept.
const HomePage = ({ month }: { month: string | null }) => {
  const { accounts, failed, retry } = useAccounts();
  const isDesktop = useIsDesktop() === true;
  const { current } = useMonths();
  // An address naming this month, or one still to come, is this month's own address, once
  // it's known when the person's month starts
  const known = useKnownMonthStart() != null;
  const later = month != null && month >= current.month;
  const unread = new URLSearchParams(window.location.search).get('month') != null && month == null;
  useEffect(() => {
    if (known && (later || unread)) navigate('', { replace: true });
  }, [known, later, unread]);
  if (accounts?.length === 0) return <FirstRun />;
  // The person's month (shared/period.ts): one named after this one is this one
  const shown = month != null && month < current.month ? month : current.month;
  return (
    <div className={isDesktop ? `${classes.page} ${classes.desktop}` : classes.page}>
      {/* The same header while the accounts load and after, so what's typed in it stays */}
      <Header
        month={shown}
        isDesktop={isDesktop}
        // Until the accounts are known it may yet be the first run, with an initial and theme
        // switch of its own; if they can't be loaded, Home keeps them (Settings, Sign out)
        known={accounts != null || failed}
      />
      {accounts != null ? (
        <Glance
          month={shown}
          isDesktop={isDesktop}
        />
      ) : failed ? (
        <div className={`${classes.card} ${classes.failed}`}>
          <p className={classes.soft}>Couldn&apos;t load your accounts.</p>
          <Button
            variant="default"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      ) : (
        <Loading
          label="Loading Home"
          className={classes.loading}
        >
          <Skeleton
            width={220}
            height={44}
          />
          <Skeleton
            width="100%"
            height={96}
          />
          <Skeleton
            width="100%"
            height={320}
          />
        </Loading>
      )}
    </div>
  );
};

export default HomePage;

/** What Home works out from the ledger and the month's totals */
interface Figures {
  isCurrent: boolean;
  today: string;
  firstDay: string;
  lastDay: string;
  at: { day: number; days: number };
}

function Glance({ month, isDesktop }: { month: string; isDesktop: boolean }) {
  const months = useMonths();
  const current = months.current.month;
  const isCurrent = month >= current;
  const { today } = months;
  const { summary, failed: monthFailed, retry: retryMonth } = useMonthSummary(month);
  // The month's days as the server summed them, once they're in; the person's month until
  // then (shared/period.ts), so the figures and their days never disagree
  const { firstDay, lastDay } = summary ?? months.of(month);
  const figures: Figures = {
    isCurrent,
    today: isCurrent ? today : lastDay,
    firstDay,
    lastDay,
    at: periodDay(firstDay, lastDay, isCurrent ? today : lastDay),
  };
  // Last month, for Getting started's "Bring in past months"
  const { summary: lastMonth } = useMonthSummary(addMonths(current, -1));
  const { data: ledger } = useWholeLedger();
  const { profile } = useProfile();
  const weekStart: WeekStart = profile?.settings.weekStart ?? 'monday';
  // Hide is kept per account: decided only once who's signed in is known
  const email = profile?.email ?? null;
  const [hiddenNow, setHiddenNow] = useState<string | null>(null);
  const hidden = email == null || hiddenNow === email || isStartedHidden(email);

  const categories = useMemo(() => categoriesOrDefaults(ledger?.categories ?? []), [ledger]);
  const lines = summary == null ? null : budgetLines(summary, categories);
  const listed = ledger?.accounts.filter((a) => !a.archived) ?? [];

  const steps: StartedSteps | null =
    ledger == null || summary == null || lastMonth == null
      ? null
      : {
          accounts:
            listed.length === 1
              ? `${listed[0].name}, ${balanceText(listed[0])}`
              : `${listed.length} accounts`,
          logged: summary.spentCents > 0,
          pastMonths: lastMonth.spentCents > 0 || lastMonth.incomeCents > 0,
          scheduled: (ledger.recurring ?? []).some((r) => !r.archived),
          budget: (lines ?? []).length > 0,
        };
  const showStarted =
    isCurrent &&
    !hidden &&
    steps != null &&
    !(steps.logged && steps.pastMonths && steps.scheduled && steps.budget);

  const coming = isCurrent && ledger != null ? comingRows(ledger, categories, today) : [];
  const due = isCurrent && ledger != null ? dueByDay(ledger, categories, today, lastDay) : null;
  const bothEmpty =
    summary != null && summary.spentByDay.length === 0 && (lines ?? []).length === 0;

  // The three answers show together, once the balances and the month's totals are in (or
  // the totals couldn't be had, when the month end shows alone and the month says so)
  const answered = ledger != null && (summary != null || monthFailed);
  const failedMonth = summary == null && monthFailed && (
    <div className={`${classes.card} ${classes.failed}`}>
      <p className={classes.soft}>Couldn&apos;t load this month.</p>
      <Button
        variant="default"
        onClick={retryMonth}
      >
        Try again
      </Button>
    </div>
  );
  const tidy = isCurrent && summary != null && (
    <TidyUp
      summary={summary}
      categories={categories}
    />
  );
  const started = showStarted && steps != null && email != null && (
    <GettingStarted
      email={email}
      steps={steps}
      onHide={() => setHiddenNow(email)}
    />
  );
  const comingUp = coming.length > 0 && (
    <ComingUp
      rows={coming}
      // Filled in by Scheduled, which adds entries on their day
      added={[]}
    />
  );
  const days =
    summary == null ? (
      !monthFailed && (
        <Skeleton
          width="100%"
          height={isDesktop ? 300 : 340}
        />
      )
    ) : (
      <DayByDay
        month={month}
        firstDay={figures.firstDay}
        lastDay={figures.lastDay}
        today={figures.today}
        isCurrent={isCurrent}
        spentByDay={summary.spentByDay}
        due={due ?? new Map()}
        weekStart={weekStart}
        tapHint={!isDesktop}
      />
    );
  const budgets =
    lines == null ? null : (
      <HomeBudgets
        lines={lines}
        at={figures.at}
        isCurrent={isCurrent}
        short={isDesktop}
      />
    );
  const combined = (
    <div className={`${classes.card} ${classes.combined}`}>
      {budgets}
      <div className={classes.rule} />
      {days}
    </div>
  );

  if (isDesktop) {
    return (
      <>
        <Answers
          month={month}
          figures={figures}
          summary={answered ? summary : null}
          ledger={answered ? ledger : null}
          lines={lines}
          isDesktop
        />
        {failedMonth}
        {isCurrent && <DueItems />}
        {tidy}
        <div className={classes.split}>
          {(started || comingUp) && (
            <div className={classes.needsColumn}>
              {started}
              {comingUp}
            </div>
          )}
          {bothEmpty
            ? combined
            : days && <div className={`${classes.card} ${classes.daysCard}`}>{days}</div>}
        </div>
        {!bothEmpty && budgets}
      </>
    );
  }
  return (
    <>
      <Answers
        month={month}
        figures={figures}
        summary={answered ? summary : null}
        ledger={answered ? ledger : null}
        lines={lines}
        isDesktop={false}
      />
      {failedMonth}
      {isCurrent && <DueItems />}
      {tidy}
      {started}
      {comingUp}
      {bothEmpty ? (
        combined
      ) : (
        <>
          {days && <div className={`${classes.card} ${classes.daysCard}`}>{days}</div>}
          {budgets != null && (
            <div className={`${classes.card} ${classes.budgetsCard}`}>{budgets}</div>
          )}
        </>
      )}
    </>
  );
}

/** The next time each scheduled item falls after today, as Coming up lists them */
function comingRows(ledger: Ledger, categories: Category[], today: string): ComingUpRow[] {
  const name = (id: string | null) => ledger.accounts.find((a) => a.id === id)?.name ?? '';
  return comingUp(ledger, today, COMING_UP).map(({ recurring: r, date }) => ({
    id: r.id,
    name: recurringName(r, categories),
    kind: r.kind,
    amountCents: r.amountCents,
    date,
    where:
      r.kind === 'transfer' ? `${name(r.accountId)} to ${name(r.toAccountId)}` : name(r.accountId),
    toCheck: false,
  }));
}

/**
 * What's still to come this month (to its last day, `end`), by day, for the calendar's dots
 * and day names
 */
function dueByDay(ledger: Ledger, categories: Category[], today: string, end: string) {
  const due = new Map<string, DueOnDay>();
  for (const item of monthEndForecast(ledger, today, end).items) {
    if (item.date < today) continue;
    const day = due.get(item.date) ?? { names: [], bill: false };
    const itemName = recurringName(item.recurring, categories);
    if (!day.names.includes(itemName)) day.names.push(itemName);
    day.bill ||= item.cents < 0;
    due.set(item.date, day);
  }
  return due;
}

/** The month's name with arrows to step between months, and on a computer the search */
function Header({
  month,
  isDesktop,
  known,
}: {
  month: string;
  isDesktop: boolean;
  known: boolean;
}) {
  const { current: thisOne } = useMonths();
  const current = thisOne.month;
  const step = (to: string) => navigate(homeAddress(to, current));
  const arrows = (
    <div className={classes.monthNav}>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="Previous month"
        disabled={month <= FIRST_MONTH}
        onClick={() => step(addMonths(month, -1))}
      >
        <CaretLeft size={20} />
      </button>
      <h1 className={classes.title}>{monthHeading(month, { short: !isDesktop })}</h1>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="Next month"
        disabled={month >= current}
        onClick={() => step(addMonths(month, 1))}
      >
        <CaretRight size={20} />
      </button>
    </div>
  );
  if (isDesktop) {
    return (
      <header className={classes.header}>
        {arrows}
        <div className={classes.headerEnd}>
          <SearchEverything />
          {known && <ThemeToggle />}
        </div>
      </header>
    );
  }
  return (
    <header className={classes.header}>
      <div className={classes.heading}>
        {arrows}
        <Freshness
          month={month}
          reserve
        />
      </div>
      <div className={classes.headerEnd}>
        {known && <ThemeToggle />}
        {known && <YouLink />}
      </div>
    </header>
  );
}

/** Home's search on a computer: Enter looks through everything in Activity */
function SearchEverything() {
  const [words, setWords] = useState('');
  return (
    <form
      role="search"
      className={classes.search}
      onSubmit={(e) => {
        e.preventDefault();
        const q = words.trim();
        navigate(q === '' ? '?activity' : `?activity&q=${encodeURIComponent(q)}`, {
          replace: true,
        });
      }}
    >
      <MagnifyingGlass
        size={18}
        aria-hidden
      />
      <input
        type="search"
        aria-label="Search everything"
        placeholder="Search everything"
        value={words}
        onChange={(e) => setWords(e.currentTarget.value)}
      />
      <span
        className={classes.kbd}
        aria-hidden
      >
        /
      </span>
    </form>
  );
}

/**
 * The three answers: where the month will land (or, for an earlier month, what it left),
 * what was spent so far and what came in
 */
function Answers({
  month,
  figures,
  summary,
  ledger,
  lines,
  isDesktop,
}: {
  month: string;
  figures: Figures;
  summary: MonthSummary | null;
  ledger: Ledger | null;
  lines: ReturnType<typeof budgetLines> | null;
  isDesktop: boolean;
}) {
  const heroId = useId();
  const { isCurrent, today, at } = figures;
  const planHref = isCurrent ? '?plan' : `?plan&month=${month}`;
  const name = monthHeading(month, { short: true });

  let hero: { eyebrow: string; cents: number | null; line: ReturnType<typeof heroLine> | null };
  if (isCurrent) {
    const forecast = ledger == null ? null : monthEndForecast(ledger, today, figures.lastDay);
    const listed: Account[] = ledger?.accounts.filter((a) => !a.archived) ?? [];
    hero = {
      eyebrow: 'Expected at month end',
      cents: forecast?.cents ?? null,
      line:
        forecast == null
          ? null
          : heroLine({
              accounts: listed,
              balancesCents: forecast.balancesCents,
              billsCents: forecast.billsCents,
              payCents: forecast.payCents,
              currency: DEFAULT_CURRENCY,
            }),
    };
  } else {
    hero = { eyebrow: `Left in ${name}`, cents: summary?.leftCents ?? null, line: null };
  }

  const pay = ledger == null ? null : nextPay(ledger);
  const payName =
    pay == null
      ? null
      : recurringName(pay.recurring, categoriesOrDefaults(ledger?.categories ?? []));
  const spentLine =
    summary == null || !isCurrent
      ? null
      : expensesLine(summary.spentCents, at, lines == null ? null : runningFast(lines, at));
  const incomeText = !isCurrent
    ? null
    : incomeLine(pay == null || payName == null ? null : { name: payName, date: pay.due });

  const figure = (cents: number | null, big: boolean) =>
    cents == null ? (
      <Skeleton
        width={big ? 220 : 110}
        height={big ? 40 : 22}
      />
    ) : (
      <span className={big ? classes.heroFigure : classes.cardFigure}>{signedMoney(cents)}</span>
    );

  const line = hero.line && (
    // Each part kept on one line, as drawn
    <span className={classes.heroLine}>
      <span className={classes.part}>{hero.line.today}</span>
      {hero.line.bills != null && (
        <>
          {' '}
          <span className={classes.part}>
            <span className={classes.neg}>{hero.line.bills}</span> bills
          </span>
        </>
      )}
      {hero.line.pay != null && (
        <>
          {' '}
          <span className={classes.part}>
            <span className={classes.pos}>{hero.line.pay}</span> pay
          </span>
        </>
      )}
    </span>
  );

  // Each card opens its last 12 months, over Home so Back returns
  const card = (label: string, cents: number | null, sub: string | null, href: string) => (
    <PageLink
      href={href}
      push
      className={`${classes.card} ${classes.answer}`}
    >
      <span className={classes.answerLabel}>{label}</span>
      {figure(cents, false)}
      {sub != null && <span className={classes.answerLine}>{lineWithFast(sub, isDesktop)}</span>}
    </PageLink>
  );
  const spentCard = card(
    'Expenses so far',
    summary?.spentCents ?? null,
    spentLine,
    `${planHref}&category=${ALL_EXPENSES}`,
  );
  const incomeCard = card(
    'Income',
    summary?.incomeCents ?? null,
    incomeText,
    `${planHref}&category=${ALL_INCOME}`,
  );

  if (isDesktop) {
    return (
      <section
        aria-label={`${name} at a glance`}
        className={classes.glance}
      >
        <PageLink
          href={isCurrent ? '?plan=scheduled' : planHref}
          className={`${classes.card} ${classes.answer}`}
        >
          <span className={classes.answerLabel}>{hero.eyebrow}</span>
          {figure(hero.cents, false)}
          {line}
        </PageLink>
        {spentCard}
        {incomeCard}
      </section>
    );
  }
  return (
    <>
      <section
        aria-labelledby={heroId}
        className={classes.hero}
      >
        <p
          id={heroId}
          className={classes.eyebrow}
        >
          {hero.eyebrow}
        </p>
        {figure(hero.cents, true)}
        {line}
      </section>
      <div className={classes.cards}>
        {spentCard}
        {incomeCard}
      </div>
    </>
  );
}

/** On a computer, the budget running fast stands out in the due colour, as drawn */
function lineWithFast(line: string, isDesktop: boolean) {
  const at = line.indexOf(' · ');
  if (!isDesktop || at < 0 || !line.endsWith(' running fast')) return line;
  return (
    <>
      {line.slice(0, at + 3)}
      <span className={classes.fast}>{line.slice(at + 3)}</span>
    </>
  );
}

/** "9 entries since Oct 1, still in Other", with Sort them opening Activity to do it */
function TidyUp({ summary, categories }: { summary: MonthSummary; categories: Category[] }) {
  const { entries, from } = summary.tidyUp;
  if (entries === 0) return null;
  const other = categories.find((c) => c.id === OTHER_EXPENSE_ID)?.name ?? 'Other';
  const words = tidyText(entries, from, other);
  return (
    <div
      role="status"
      className={classes.tidy}
    >
      <Rows
        size={18}
        className={classes.tidyIcon}
        aria-hidden
      />
      <span className={classes.tidyText}>
        <b>{words.count}</b> <span className={classes.soft}>{words.rest}</span>
      </span>
      <PageLink
        href={`?activity&category=${OTHER_EXPENSE_ID}&from=${from}&select`}
        className={classes.sortThem}
      >
        Sort them
      </PageLink>
    </div>
  );
}
