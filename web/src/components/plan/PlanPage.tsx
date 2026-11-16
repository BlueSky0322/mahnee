import AccountList from '../accounts/AccountList';
import DueItems from '../home/DueItems';
import MonthCard from '../home/MonthCard';
import MonthEnd from '../home/MonthEnd';
import classes from './PlanPage.module.css';

/** Plan's address for `month`: this month's names none */
const planAddress = (month: string | null) => (month == null ? '?plan' : `?plan&month=${month}`);

// Plan (?plan), until Plan and Scheduled are rebuilt, is the month as Home showed it before
// Home was at a glance: what's due now to log or skip (Home lists it too, under what needs
// you), where the spending went with each budget, what's expected at the month's end, and
// the accounts behind it. Its arrows step between months on Plan (?plan&month=2026-10).
export default function PlanPage({ month }: { month: string | null }) {
  return (
    <div className={classes.page}>
      <h1 className={classes.title}>Plan</h1>
      <DueItems />
      <MonthCard
        month={month}
        address={planAddress}
      />
      <MonthEnd />
      <AccountList />
    </div>
  );
}
