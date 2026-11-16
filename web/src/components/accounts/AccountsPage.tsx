import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useAccounts } from '../../ledger/useLedger';
import AccountPage, { NotFound } from './AccountPage';
import AccountPane from './AccountPane';
import AccountsList from './AccountsList';
import classes from './AccountsPage.module.css';

// Accounts (?accounts) and one account (?account=<id>). Phones and tablets show one page at
// a time: the list, or the account's own page. A computer shows both: the list on the left,
// and on the right the account picked, or with none picked the first running one.
export default function AccountsPage({ id }: { id: string | null }) {
  const isDesktop = useIsDesktop();
  const { accounts } = useAccounts();
  if (!isDesktop) {
    return id == null ? (
      <div className={classes.page}>
        <AccountsList />
      </div>
    ) : (
      <AccountPage
        key={id}
        id={id}
      />
    );
  }
  const open =
    id != null
      ? accounts?.find((a) => a.id === id)
      : accounts?.find((a) => !a.archived) ?? accounts?.[0];
  return (
    <div
      className={classes.page}
      data-layout="panes"
    >
      <AccountsList selected={open?.id ?? null} />
      {accounts != null &&
        (open != null ? (
          <AccountPane
            key={open.id}
            account={open}
          />
        ) : (
          id != null && <NotFound beside />
        ))}
    </div>
  );
}
