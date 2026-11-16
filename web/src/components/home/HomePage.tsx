import AccountList from '../accounts/AccountList';
import { InstallCard } from '../common/InstallApp';
import ThemeToggle from '../common/ThemeToggle';
import YouLink from '../common/YouLink';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useAccounts } from '../../ledger/useLedger';
import { thisMonth } from '../../utils/date-input';
import DueItems from './DueItems';
import classes from './HomePage.module.css';
import MonthCard from './MonthCard';
import MonthEnd from './MonthEnd';
import Staleness from './Staleness';

// The first screen. It says how old the numbers are when they came from this device, then
// what repeating bills and income are due now, to log or skip. Then the month at a glance
// (`month`, an earlier one; null for this one) and, while anything repeats, what's expected
// at its end, then the person's accounts. Until the first account is added there's no month
// to show. The round initial in the header opens Settings, on phones and tablets, and on a
// computer until there's an account (the sidebar holds Settings after that).
const HomePage = ({ month }: { month: string | null }) => {
  const { accounts } = useAccounts();
  const isDesktop = useIsDesktop();
  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <h1 className={classes.title}>Mahnee</h1>
        <div className={classes.headerEnd}>
          <ThemeToggle />
          {(!isDesktop || accounts?.length === 0) && <YouLink />}
        </div>
      </header>
      <Staleness month={month ?? thisMonth()} />
      <DueItems />
      {accounts?.length !== 0 && <MonthCard month={month} />}
      <MonthEnd />
      <InstallCard />
      <AccountList />
    </div>
  );
};

export default HomePage;
