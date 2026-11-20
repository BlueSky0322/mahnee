import { useState } from 'react';
import type { AccountKind } from '@shared/ledger';
import AccountForm from '../accounts/AccountForm';
import KindIcon from '../accounts/KindIcon';
import AppLogo from '../common/AppLogo';
import YouLink from '../common/YouLink';
import classes from './Home.module.css';

const KINDS: { kind: AccountKind; name: string; line: string }[] = [
  { kind: 'bank', name: 'Bank', line: 'Savings or current' },
  { kind: 'ewallet', name: 'E-wallet', line: "Touch 'n Go, GrabPay, ShopeePay" },
  { kind: 'card', name: 'Card', line: "You enter what's owed" },
  { kind: 'cash', name: 'Cash', line: 'In your wallet' },
];

// The first run, in place of everything until there's an account, under the logo: where
// the money is kept, one kind at a time, each opening Add account with that kind chosen.
// The kinds explain the choice; the categories it comes with are told of on Categories,
// and adding a bank's account before its CSV beside Import.
// The round initial still leads to Settings (and Sign out, and the theme in Look and start).
export default function FirstRun() {
  const [open, setOpen] = useState<{ account: null; kind: AccountKind } | null>(null);
  return (
    <div className={classes.firstRun}>
      <div className={classes.firstTop}>
        <p className={classes.brand}>
          <AppLogo size={22} />
          {/* The logo is read out as Mahnee already */}
          <span aria-hidden="true">Mahnee</span>
        </p>
        <div className={classes.headerEnd}>
          <YouLink />
        </div>
      </div>
      <section className={classes.firstIntro}>
        <h1 className={classes.firstTitle}>Where do you keep your money?</h1>
        <p className={classes.firstLead}>Add each one with today&apos;s balance. No bank login.</p>
      </section>
      <div className={classes.kinds}>
        {KINDS.map(({ kind, name, line }) => (
          <button
            key={kind}
            type="button"
            className={classes.kind}
            onClick={() => setOpen({ account: null, kind })}
          >
            <KindIcon
              kind={kind}
              size={24}
            />
            <strong>{name}</strong>
            <span>{line}</span>
          </button>
        ))}
      </div>
      <div className={classes.firstFoot}>
        <p className={classes.small}>Works offline</p>
      </div>
      <AccountForm
        open={open}
        count={0}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
