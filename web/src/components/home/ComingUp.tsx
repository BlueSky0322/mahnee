import { useId } from 'react';
import { useCurrency } from '../../profile/ProfileContext';
import type { TransactionKind } from '@shared/ledger';
import { formatMoney } from '../../utils/money';
import classes from './Home.module.css';
import { shortDate } from './home-text';
import PageLink from './PageLink';

/** One scheduled item as Coming up lists it */
export interface ComingUpRow {
  id: string;
  /** Who's paid (or pays), else its category */
  name: string;
  kind: TransactionKind;
  amountCents: number;
  /** Its next day after today */
  date: string;
  /** The account it's on, or for a transfer "Maybank Savings to Cash" */
  where: string;
  /** Its amount varies, so it's added and flagged to check (from Scheduled) */
  toCheck: boolean;
}

/** An entry Scheduled added whose amount is still to check */
export interface ComingUpCheck {
  id: string;
  name: string;
  amountCents: number;
  /** The day it was added on */
  date: string;
}

// What needs you next: each entry Scheduled added whose amount is still to check (tapping
// one opens its day in Activity, where it's confirmed), the scheduled items coming up, each
// with its amount and day, and what Scheduled added this month, with Scheduled a tap away
export default function ComingUp({
  rows,
  added,
  checks = [],
}: {
  rows: readonly ComingUpRow[];
  /** What Scheduled added this month on its own, by name */
  added: readonly string[];
  checks?: readonly ComingUpCheck[];
}) {
  const homeCurrency = useCurrency();
  const titleId = useId();
  return (
    <section
      className={`${classes.card} ${classes.coming}`}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Coming up
        </h2>
        <PageLink
          href="?plan=scheduled"
          className={classes.more}
        >
          All scheduled
        </PageLink>
      </div>
      <ul className={classes.needs}>
        {checks.map((check) => (
          <li
            key={`check-${check.id}`}
            className={classes.need}
          >
            <PageLink
              href={`?activity&day=${check.date}`}
              className={classes.needLink}
            >
              <span className={classes.needTitle}>
                {`${check.name} · `}
                <span className={classes.num}>{formatMoney(check.amountCents, homeCurrency)}</span>
              </span>
              <span
                className={classes.needLine}
              >{`${shortDate(check.date)} · amount to check`}</span>
            </PageLink>
          </li>
        ))}
        {rows.map((row) => (
          <li
            key={row.id}
            className={classes.need}
          >
            <span className={classes.needTitle}>
              {`${row.name} · `}
              <span
                className={row.kind === 'income' ? `${classes.num} ${classes.pos}` : classes.num}
              >
                {`${row.kind === 'income' ? '+' : ''}${formatMoney(row.amountCents, homeCurrency)}`}
              </span>
            </span>
            <span className={classes.needLine}>
              {`${shortDate(row.date)} · ${row.toCheck ? 'amount to check' : row.where}`}
            </span>
          </li>
        ))}
      </ul>
      {added.length > 0 && (
        <p className={classes.added}>{`Added this month: ${added.join(', ')}`}</p>
      )}
    </section>
  );
}
