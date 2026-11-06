import { useState } from 'react';
import type { Recurring } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { anyRepeating, monthEndForecast } from '../../ledger/forecast';
import { useWholeLedger } from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './Recurring.module.css';
import RecurringSheet from './RecurringSheet';
import {
  currencyOf,
  recurringName,
  scheduleText,
  shortDay,
  signedMoneyOf,
  totalMoney,
} from './recurring-text';

/** The most rows of what's still due the list shows; the rest are counted */
const SHOWN_ROWS = 100;

// One total on Home while anything repeats: "Expected at month end: RM 2,340.00", today's
// balances of every listed account less the bills still due this month plus the income
// still due (ledger/forecast.ts). Below zero it says so in words. Tapping it lists what makes
// it up, and every repeating item, each opening its sheet to change it or stop it.
export default function MonthEnd() {
  const { data: ledger } = useWholeLedger();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Recurring | null>(null);
  if (ledger == null) return null;
  const sheet = (
    <RecurringSheet
      recurring={editing}
      onClose={() => setEditing(null)}
    />
  );
  if (!anyRepeating(ledger)) return sheet;
  const forecast = monthEndForecast(ledger, toDateInput(new Date()));
  const total = totalMoney(forecast.cents);
  const repeating = (ledger.recurring ?? []).filter((r) => !r.archived);
  return (
    <section className={classes.total}>
      <button
        type="button"
        className={classes.totalButton}
        aria-label={`Expected at month end: ${total}`}
        onClick={() => setOpen(true)}
      >
        <span className={classes.totalLabel}>Expected at month end</span>
        <span
          className={
            forecast.cents < 0 ? `${classes.totalFigure} ${classes.negative}` : classes.totalFigure
          }
        >
          {total}
        </span>
      </button>
      {forecast.cents < 0 && (
        <p className={classes.belowZero}>
          {formatMoney(-forecast.cents, DEFAULT_CURRENCY)} below zero
        </p>
      )}
      <ResponsiveDialog
        opened={open}
        onClose={() => setOpen(false)}
        title="Expected at month end"
      >
        <p className={classes.balances}>
          <span>Balances today</span>
          <span>{totalMoney(forecast.balancesCents)}</span>
        </p>
        <h3 className={classes.listTitle}>Still due this month</h3>
        {forecast.items.length === 0 ? (
          <p className={classes.muted}>Nothing else is due this month.</p>
        ) : (
          <ul
            className={classes.list}
            aria-label="Still due this month"
          >
            {forecast.items.slice(0, SHOWN_ROWS).map((item) => (
              <li
                key={`${item.recurring.id}:${item.date}`}
                className={classes.item}
              >
                <span className={classes.itemDay}>{shortDay(item.date)}</span>{' '}
                <span className={classes.itemName}>
                  {recurringName(item.recurring, ledger.categories)}
                </span>{' '}
                <span className={classes.itemMoney}>
                  {signedMoneyOf(item.cents, currencyOf(item.recurring, ledger.accounts))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {forecast.items.length > SHOWN_ROWS && (
          <p className={classes.muted}>And {forecast.items.length - SHOWN_ROWS} more</p>
        )}
        <h3 className={classes.listTitle}>Repeating</h3>
        <ul className={classes.list}>
          {repeating.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={classes.repeating}
                // Over the list, so closing it (or Back) comes back to the list
                onClick={() => setEditing(r)}
              >
                <span>
                  {recurringName(r, ledger.categories)},{' '}
                  {formatMoney(r.amountCents, currencyOf(r, ledger.accounts))}
                </span>
                <span className={classes.repeatingDetail}>
                  {scheduleText(r)}, next due {shortDay(r.nextDue)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </ResponsiveDialog>
      {sheet}
    </section>
  );
}
