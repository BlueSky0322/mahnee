import { useId } from 'react';
import { useCurrency } from '../../profile/ProfileContext';
import type { Ledger } from '@shared/api';
import { nextThirtyDays } from '../../ledger/forecast';
import { formatMoney } from '../../utils/money';
import { balanceText } from '../accounts/account-text';
import { shortDate } from '../home/home-text';
import classes from './Scheduled.module.css';

// The next 30 days on Scheduled (owner decision D12; not drawn, so its wording is proposed
// for the owner to change): from today's balances and what's scheduled, what comes in and
// goes out up to the day 30 days on, and each account an item touches at its lowest, with
// the day. A quiet card under what's drawn, in the same look as the groups.

export default function NextDays({ ledger, today }: { ledger: Ledger; today: string }) {
  const homeCurrency = useCurrency();
  const id = useId();
  const next = nextThirtyDays(ledger, today);
  const nothing = next.lowest.length === 0;
  const total = (cents: number, sign: string) =>
    `${cents === 0 ? '' : sign}${formatMoney(cents, homeCurrency)}`;
  return (
    <section
      className={classes.group}
      aria-labelledby={id}
    >
      <div className={classes.groupHead}>
        <h2
          id={id}
          className={classes.groupTitle}
        >
          Next 30 days
        </h2>
        <span className={classes.groupAside}>{`to ${shortDate(next.until)}`}</span>
      </div>
      <div className={classes.nextCard}>
        {nothing ? (
          <p className={classes.nextSoft}>Nothing scheduled in these 30 days.</p>
        ) : (
          <>
            <div className={classes.nextLine}>
              <span>Coming in</span>
              <span
                className={`${classes.amount} sf-tabular`}
                data-kind={next.inCents > 0 ? 'income' : undefined}
              >
                {total(next.inCents, '+')}
              </span>
            </div>
            <div className={classes.nextLine}>
              <span>Going out</span>
              <span className={`${classes.amount} sf-tabular`}>{total(next.outCents, '−')}</span>
            </div>
            <h3
              id={`${id}-low`}
              className={classes.nextLabel}
            >
              Lowest point
            </h3>
            <ul
              className={classes.nextList}
              aria-labelledby={`${id}-low`}
            >
              {next.lowest.map(({ account, cents, date }) => (
                <li
                  key={account.id}
                  className={classes.nextLine}
                >
                  <span className={classes.nextName}>{account.name}</span>
                  <span className={classes.nextLow}>
                    <span className="sf-tabular">
                      {balanceText({ ...account, balanceCents: cents })}
                    </span>
                    <span className={classes.nextWhen}>
                      {date === today ? 'today' : `on ${shortDate(date)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className={classes.nextSoft}>
              From today&apos;s balances and what&apos;s scheduled. Spending that isn&apos;t
              scheduled isn&apos;t counted.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
