import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { useId } from 'react';
import type { Recurring } from '@shared/api';
import { change, isDueOn } from '../../ledger/ledger';
import { addedOnReturn, dueNow } from '../../ledger/forecast';
import { useWholeLedger } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { isConverting } from '@shared/api';
import { dayIn } from '@shared/scheduled';
import { toDateInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { showUndo } from '../common/undo-toast';
import classes from './Recurring.module.css';
import { dueText, recurringName, shortDay } from './recurring-text';

// What's due now at the top of Home: each scheduled item that asks first (owner decision
// D19: overdue when it was saved, moved back or brought back) whose next due date is today
// or before, with Log it (records it on the day it was due, and moves it on) and Skip (moves
// it on, recording nothing). Every other item is added on its day by the server.
//
// Offline, the server may have added an item on its day without this device hearing of it:
// each such occurrence shows here as projected, "Scheduled, adds when back online", with
// nothing to do; once back, the server's entry takes its place.
export default function DueItems() {
  const { data: ledger } = useWholeLedger();
  const { online } = useNetwork();
  const { profile } = useProfile();
  if (ledger == null) return null;
  const today = toDateInput(new Date());
  const due = dueNow(ledger, today);
  // Not while amounts convert into a new currency: the server adds nothing then either
  const zone = profile?.settings.timeZone ?? null;
  const projected =
    online || profile == null || isConverting(profile)
      ? []
      : addedOnReturn(ledger, Date.now(), zone);
  // The person's own day, as the server counts it
  const zoneToday = (zone == null ? null : dayIn(zone, Date.now())) ?? today;
  if (due.length === 0 && projected.length === 0) return null;
  return (
    <section
      className={classes.due}
      aria-label="Due now"
    >
      {projected.map(({ recurring, due: day }) => (
        <ProjectedRow
          key={`${recurring.id}:${day}`}
          due={day}
          today={zoneToday}
          text={dueText(recurring, ledger.accounts, ledger.categories)}
        />
      ))}
      {due.map(({ recurring, due: day }) => (
        <DueRow
          key={recurring.id}
          recurring={recurring}
          due={day}
          text={dueText(recurring, ledger.accounts, ledger.categories)}
          name={recurringName(recurring, ledger.categories)}
        />
      ))}
    </section>
  );
}

/** An occurrence the server adds on its day, shown until this device hears of it */
function ProjectedRow({ due, today, text }: { due: string; today: string; text: string }) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={classes.dueRow}
    >
      <div className={classes.dueText}>
        <span id={id}>{text}</span>
        <span className={classes.dueDay}>
          {due >= today ? 'Due today' : `Was due ${shortDay(due)}`}
        </span>
        <span className={classes.dueDay}>Scheduled, adds when back online</span>
      </div>
    </div>
  );
}

function DueRow({
  recurring: r,
  due,
  text,
  name,
}: {
  recurring: Recurring;
  due: string;
  text: string;
  name: string;
}) {
  const id = useId();
  const log = () => {
    // Logged or skipped already (a second tap): nothing more to record
    if (!isDueOn(r.id, due)) return;
    const transactionId = newId();
    change({
      op: 'logRecurring',
      id: r.id,
      due,
      transaction: {
        id: transactionId,
        kind: r.kind,
        accountId: r.accountId,
        toAccountId: r.toAccountId,
        amountCents: r.amountCents,
        categoryId: r.categoryId,
        payee: r.payee,
        note: null,
        date: due,
        // From Scheduled, as the server marks it
        scheduled: { recurringId: r.id, due, toCheck: false },
      },
    });
    showUndo(`Logged ${name}`, () =>
      change(
        { op: 'removeTransaction', id: transactionId },
        { op: 'updateRecurring', id: r.id, nextDue: due },
      ),
    );
  };
  const skip = () => {
    if (!isDueOn(r.id, due)) return;
    change({ op: 'skipRecurring', id: r.id, due });
    showUndo(`Skipped ${name}`, () => change({ op: 'updateRecurring', id: r.id, nextDue: due }));
  };
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={classes.dueRow}
    >
      <div className={classes.dueText}>
        <span id={id}>{text}</span>
        <span className={classes.dueDay}>
          {due === toDateInput(new Date()) ? 'Due today' : `Was due ${shortDay(due)}`}
        </span>
      </div>
      <div className={classes.dueActions}>
        <Button
          size="xs"
          onClick={log}
        >
          Log it
        </Button>
        <Button
          size="xs"
          variant="default"
          onClick={skip}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
