import { Button } from '@mantine/core';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { againstAverage } from '@shared/trend';
import { monthLabel } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './MonthCard.module.css';

/** Every amount here is in the one currency accounts are kept in for now */
const money = (cents: number) => formatMoney(cents, DEFAULT_CURRENCY);

/** One month's amount: the 12 a category, Spent or Received shows */
export interface MonthAmount {
  month: string;
  cents: number;
}

/**
 * The last 12 months of a category, of spending or of income, opened in place on the month
 * card: one bar a month, oldest first, with its amount, the month shown highlighted; then
 * the average of the 11 months before it, and how the month shown compares with it. Says
 * so, with nothing made up, when the months couldn't be read.
 */
export default function TwelveMonths({
  id,
  name,
  months,
  failed,
  retry,
}: {
  id?: string;
  /** What the months are of, as read out: "Food, last 12 months" */
  name: string;
  /** Oldest first, the month shown last; null until loaded */
  months: MonthAmount[] | null;
  failed: boolean;
  retry: () => void;
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={`${name}, last 12 months`}
      className={classes.twelve}
    >
      <h4 className={classes.twelveTitle}>Last 12 months</h4>
      {months == null ? (
        failed ? (
          <div className={classes.failed}>
            <p className={classes.muted}>Couldn't load the last 12 months.</p>
            <Button
              variant="default"
              size="xs"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Loading label="Loading the last 12 months">
            <Skeleton
              width="100%"
              height={120}
            />
          </Loading>
        )
      ) : (
        <Bars months={months} />
      )}
    </div>
  );
}

function Bars({ months }: { months: MonthAmount[] }) {
  const largest = Math.max(0, ...months.map((m) => m.cents));
  const { averageCents, byCents, direction } = againstAverage(months.map((m) => m.cents));
  return (
    <>
      <ul className={classes.twelveBars}>
        {months.map(({ month, cents }, i) => {
          const shown = i === months.length - 1;
          // A share of the bar's width, for drawing only: the amounts stay in cents
          const share =
            largest > 0 && cents > 0 ? Math.max(1, Math.round((cents / largest) * 100)) : 0;
          return (
            <li
              key={month}
              className={shown ? `${classes.twelveRow} ${classes.twelveShown}` : classes.twelveRow}
              aria-current={shown ? 'true' : undefined}
            >
              <span className={classes.twelveMonth}>{monthLabel(month)}</span>
              <span className="sr-only">, </span>
              <span
                className={classes.twelveTrack}
                aria-hidden
              >
                <span
                  className={classes.twelveBar}
                  style={{ width: `${share}%` }}
                />
              </span>
              <span className={classes.twelveAmount}>{money(cents)}</span>
            </li>
          );
        })}
      </ul>
      <p className={classes.twelveLine}>{`Average ${money(averageCents)} a month (previous 11)`}</p>
      <p className={classes.twelveLine}>
        {direction === 'same'
          ? 'This month the same as average'
          : `This month ${money(byCents)} ${direction} average`}
      </p>
    </>
  );
}
