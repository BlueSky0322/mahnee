import { Button } from '@mantine/core';
import { CaretLeft } from '@phosphor-icons/react';
import { useId } from 'react';
import type { MonthTrend } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { againstAverage } from '@shared/trend';
import { goUp } from '../../hooks/useRoute';
import { useMonthSummary, useMonthTrend } from '../../ledger/useLedger';
import { monthHeading } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './Plan.module.css';
import type { MonthAmount } from './CategoryView';
import { Shell, YearBars } from './CategoryView';
import type { PlanMonth } from './plan-month';
import { usualText, yearComparison } from './plan-text';

const money = (cents: number) => formatMoney(cents, DEFAULT_CURRENCY);

/** Every expense, or all income, in each of the 12 months ending at the month shown */
const yearOf = (trend: MonthTrend, income: boolean): MonthAmount[] =>
  trend.months.map((m) => ({ month: m.month, cents: income ? m.incomeCents : m.spentCents }));

// Every expense or all income over 12 months, opened from Home's "Expenses so far" and
// "Income": the month's total against the usual (the average of the 11 months before), and
// the 12 months as bars, ending at the month shown. Money moved between accounts is neither.
// On phones and tablets it is a page of its own, with Back to Home; on a computer it sits
// beside Plan's table, as a category does.
export default function TotalView({
  which,
  shown,
  variant,
}: {
  which: 'expenses' | 'income';
  shown: PlanMonth;
  variant: 'page' | 'pane';
}) {
  const { summary, failed, retry } = useMonthSummary(shown.month);
  const trend = useMonthTrend(shown.month);
  const titleId = useId();
  const isPage = variant === 'page';
  const income = which === 'income';
  const name = income ? 'All income' : 'All expenses';
  // Home's address for the month shown, where these are opened from
  const back = () => goUp(shown.isCurrent ? '' : `?month=${shown.month}`);

  const header = isPage && (
    <header className={classes.pageHeader}>
      <Button
        variant="subtle"
        color="gray"
        size="compact-md"
        className={classes.back}
        leftSection={<CaretLeft size={16} />}
        onClick={back}
      >
        Home
      </Button>
    </header>
  );
  const title = isPage ? (
    <h1
      id={titleId}
      className={classes.categoryTitle}
    >
      {name}
    </h1>
  ) : (
    <div className={classes.paneHead}>
      <h2
        id={titleId}
        className={classes.paneTitle}
      >
        {name}
      </h2>
    </div>
  );

  if (summary == null) {
    return (
      <Shell
        isPage={isPage}
        titleId={titleId}
      >
        {header}
        {title}
        {failed ? (
          <div className={classes.failed}>
            <p className={classes.soft}>Couldn&apos;t load this month.</p>
            <Button
              variant="default"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Loading label="Loading this month">
            <Skeleton
              width="100%"
              height={150}
            />
          </Loading>
        )}
      </Shell>
    );
  }

  const cents = income ? summary.incomeCents : summary.spentCents;
  const year = trend.trend == null ? null : yearOf(trend.trend, income);
  const usual = year == null ? null : usualText(againstAverage(year.map((m) => m.cents)));
  const comparison = year == null ? null : yearComparison(year);
  const monthName = monthHeading(shown.month, { short: true });
  const colour = income ? 'var(--pos)' : 'var(--accent)';

  return (
    <Shell
      isPage={isPage}
      titleId={titleId}
    >
      {header}
      <div className={isPage ? classes.categoryTop : classes.paneTop}>
        {title}
        <p className={`${classes.num} ${isPage ? classes.bigFigure : classes.paneFigure}`}>
          {money(cents)}
        </p>
        {usual != null && (
          <p className={classes.soft}>
            {isPage ? `${income ? 'Received' : 'Spent'} in ${monthName} · ${usual}` : usual}
          </p>
        )}
      </div>

      <section
        aria-label={`${name}, last 12 months${comparison != null ? `, ${comparison}` : ''}`}
        className={isPage ? `${classes.card} ${classes.year}` : classes.yearPane}
      >
        {year == null ? (
          trend.failed ? (
            <div className={classes.failed}>
              <p className={classes.soft}>Couldn&apos;t load the last 12 months.</p>
              <Button
                variant="default"
                size="xs"
                onClick={trend.retry}
              >
                Try again
              </Button>
            </div>
          ) : (
            <Loading label="Loading the last 12 months">
              <Skeleton
                width="100%"
                height={150}
              />
            </Loading>
          )
        ) : (
          <YearBars
            months={year}
            colour={colour}
          />
        )}
      </section>
    </Shell>
  );
}
