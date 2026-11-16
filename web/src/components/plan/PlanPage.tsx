import MonthCard from '../home/MonthCard';
import MonthEnd from '../home/MonthEnd';
import classes from './PlanPage.module.css';

/** Plan's address for `month`: this month's names none */
const planAddress = (month: string | null) => (month == null ? '?plan' : `?plan&month=${month}`);

// Plan (?plan), for now what Home shows of the month: where the spending went with each
// budget, and what's expected at the month's end. Its arrows step between months on Plan
// (?plan&month=2026-10). The month card is the same one Home has until Plan is rebuilt.
export default function PlanPage({ month }: { month: string | null }) {
  return (
    <div className={classes.page}>
      <h1 className={classes.title}>Plan</h1>
      <MonthCard
        month={month}
        address={planAddress}
      />
      <MonthEnd />
    </div>
  );
}
