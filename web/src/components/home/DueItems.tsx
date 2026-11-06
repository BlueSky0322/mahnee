import { Button } from '@mantine/core';
import { useId } from 'react';
import type { Recurring } from '@shared/api';
import { change, isDueOn } from '../../ledger/ledger';
import { dueNow } from '../../ledger/forecast';
import { useWholeLedger } from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { showUndo } from '../common/undo-toast';
import classes from './Recurring.module.css';
import { dueText, recurringName, shortDay } from './recurring-text';

// What's due now at the top of Home: each repeating bill or income whose next due date is
// today or before, with Log it (records it on the day it was due, and moves it on) and Skip
// (moves it on, recording nothing). Nothing is recorded until one of them is tapped.
export default function DueItems() {
  const { data: ledger } = useWholeLedger();
  if (ledger == null) return null;
  const due = dueNow(ledger, toDateInput(new Date()));
  if (due.length === 0) return null;
  return (
    <section
      className={classes.due}
      aria-label="Due now"
    >
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
          size="compact-md"
          onClick={log}
        >
          Log it
        </Button>
        <Button
          size="compact-md"
          variant="default"
          onClick={skip}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
