import AccountList from './AccountList';
import classes from './AccountsPage.module.css';

// Accounts (?accounts), for now today's list of accounts with their balances
export default function AccountsPage() {
  return (
    <div className={classes.page}>
      <AccountList asPage />
    </div>
  );
}
