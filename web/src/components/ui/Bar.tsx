import classes from './Bar.module.css';

/** How spending compares with the month: on track, faster than the month, or over */
export type BarState = 'on-track' | 'faster' | 'over';

interface BarProps {
  /** The facts in words, such as "Food: 27% of budget spent, a third of the month gone" */
  label: string;
  /** How much of the budget is spent, in percent; past 100 when over */
  spent: number;
  /** How much of the month has gone, in percent: where the today marker sits; null for none */
  today: number | null;
  state: BarState;
}

const percent = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

/**
 * A budget bar: filled as far as is spent (ink, amber when faster than the month, red when
 * over), with a marker at how much of the month has gone (none once the month is over). Its
 * name says it all in words.
 */
const Bar = ({ label, spent, today, state }: BarProps) => (
  <div
    role="meter"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent(spent)}
    data-state={state}
    className={classes.bar}
  >
    <span
      data-part="fill"
      className={classes.fill}
      style={{ width: `${percent(spent)}%` }}
    />
    {today != null && (
      <span
        data-part="today"
        className={classes.today}
        style={{ left: `${percent(today)}%` }}
      />
    )}
  </div>
);

export default Bar;
