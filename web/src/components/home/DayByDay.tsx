import { useId } from 'react';
import type { DayTotal, WeekStart } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { dayByDay } from '../../ledger/day-by-day';
import { monthHeading } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import classes from './Home.module.css';
import { dayLabel, leadingBlanks, weekdays } from './home-text';
import PageLink from './PageLink';

/** What's still to come on a day this month: the items' names, and whether any is a bill */
export interface DueOnDay {
  names: string[];
  bill: boolean;
}

/** An arrow up (more than the middle day) or down (less) */
const Arrow = ({ up }: { up: boolean }) => (
  <svg
    width="8"
    height="6"
    viewBox="0 0 8 6"
    aria-hidden="true"
    className={up ? classes.up : classes.down}
  >
    <path
      d={up ? 'M4 0l4 6H0z' : 'M4 6L0 0h8z'}
      fill="currentColor"
    />
  </svg>
);

// "Day by day": each day of the month against the middle day so far (the median of each
// day's spending from the 1st to today). A day above it has an amber up arrow, one at or
// below it a green down arrow; today is ringed, days to come are grey, and a dot marks a
// bill (amber) or pay (green) still to come. Each day opens Activity on that day. Weeks
// start on the day the person chose. Before anything is spent, it says it fills in.
export default function DayByDay({
  month,
  firstDay,
  lastDay,
  today,
  isCurrent,
  spentByDay,
  due,
  weekStart,
  tapHint,
}: {
  month: string;
  firstDay: string;
  lastDay: string;
  /** The person's own today; an earlier month passes its last day */
  today: string;
  isCurrent: boolean;
  spentByDay: readonly DayTotal[];
  /** What's still to come, by day (this month only) */
  due: ReadonlyMap<string, DueOnDay>;
  weekStart: WeekStart;
  /** Says "Tap a day to see it" (phones) */
  tapHint: boolean;
}) {
  const titleId = useId();
  const { middleCents, days } = dayByDay(spentByDay, firstDay, lastDay, today);
  const empty = spentByDay.length === 0;

  const cells: ((typeof days)[number] | null)[] = [
    ...Array.from({ length: leadingBlanks(firstDay, weekStart) }, () => null),
    ...days,
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  return (
    <section
      className={classes.days}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Day by day
        </h2>
        {!empty && middleCents != null && (
          <span className={classes.middle}>
            middle day{' '}
            <span className={classes.num}>{formatMoney(middleCents, DEFAULT_CURRENCY)}</span>
          </span>
        )}
      </div>
      {empty ? (
        <p className={classes.soft}>Fills in as you log.</p>
      ) : (
        <>
          <div
            role="grid"
            aria-label={`${monthHeading(month)}, each day against the middle day so far`}
            className={classes.grid}
          >
            <div
              role="row"
              className={classes.week}
            >
              {weekdays(weekStart).map((d, i) => (
                <span
                  key={i}
                  role="columnheader"
                  className={classes.weekday}
                >
                  {d}
                </span>
              ))}
            </div>
            {weeks.map((week, w) => (
              <div
                key={w}
                role="row"
                className={classes.week}
              >
                {week.map((day, i) => {
                  if (day == null) {
                    return (
                      <span
                        key={i}
                        role="gridcell"
                      />
                    );
                  }
                  const dueOn = isCurrent && day.date >= today ? due.get(day.date) : undefined;
                  const isToday = isCurrent && day.date === today;
                  return (
                    <span
                      key={i}
                      role="gridcell"
                    >
                      <PageLink
                        href={`?activity&day=${day.date}`}
                        aria-label={dayLabel(day, dueOn?.names ?? [])}
                        aria-current={isToday ? 'date' : undefined}
                        data-against={day.against ?? 'later'}
                        className={classes.day}
                      >
                        <span>{Number(day.date.slice(8))}</span>
                        {day.against != null && <Arrow up={day.against === 'more'} />}
                        {dueOn != null && (
                          <span
                            className={`${classes.dot} ${dueOn.bill ? classes.dotBill : classes.dotPay}`}
                          />
                        )}
                      </PageLink>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={classes.legend}>
            <span>
              <Arrow up />
              more
            </span>
            <span>
              <Arrow up={false} />
              less
            </span>
            <span>
              <span className={`${classes.dot} ${classes.dotKey}`} />
              bill or pay due
            </span>
            {tapHint && <span className={classes.hint}>Tap a day to see it</span>}
          </div>
        </>
      )}
    </section>
  );
}
