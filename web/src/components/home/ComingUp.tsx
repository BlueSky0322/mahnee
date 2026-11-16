import { useId } from 'react';
import type { TransactionKind } from '@shared/ledger';
import { DEFAULT_CURRENCY } from '@shared/ledger';
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

// What needs you next: the scheduled items coming up, each with its amount and day, and
// what was added this month on its own (from Scheduled), with Scheduled a tap away
export default function ComingUp({
  rows,
  added,
}: {
  rows: readonly ComingUpRow[];
  /** What Scheduled added this month on its own, by name */
  added: readonly string[];
}) {
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
                {`${row.kind === 'income' ? '+' : ''}${formatMoney(row.amountCents, DEFAULT_CURRENCY)}`}
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
