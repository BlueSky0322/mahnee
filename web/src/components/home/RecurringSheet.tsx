import { Button, NativeSelect, TextInput } from '@mantine/core';
import { StopCircle } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { LedgerChange, Recurring } from '@shared/api';
import { MAX_PAYEE, categoryKindFor, readOptionalText } from '@shared/ledger';
import type { Schedule } from '@shared/recurring';
import { onOrAfter } from '@shared/recurring';
import { change } from '../../ledger/ledger';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { currencySymbol } from '../../utils/money';
import { showUndo } from '../common/undo-toast';
import { amountText, readAmount } from '../entry/entry-text';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './Recurring.module.css';
import { recurringName, weekdayName } from './recurring-text';

// One repeating item, opened from the list behind the month-end total: what it records
// (amount, payee, category, account) and when it falls (monthly on a day, or weekly on a
// weekday), or Stop repeating (with Undo). Its kind stays what it was set up as.
export default function RecurringSheet({
  recurring,
  onClose,
}: {
  recurring: Recurring | null;
  onClose: () => void;
}) {
  // What was opened stays drawn while the sheet closes, rather than emptying as it goes
  const [shown, setShown] = useState(recurring);
  if (recurring != null && recurring !== shown) setShown(recurring);
  const drawn = recurring ?? shown;
  return (
    <ResponsiveDialog
      opened={recurring != null}
      onClose={onClose}
      title="Repeating"
      width={480}
    >
      {drawn != null && (
        <Fields
          key={drawn.id}
          recurring={drawn}
          onDone={onClose}
        />
      )}
    </ResponsiveDialog>
  );
}

const PAYEE_LABELS = { expense: 'Paid to', income: 'From', transfer: 'What for' } as const;

const dayOptions = (schedule: Schedule) =>
  schedule === 'monthly'
    ? Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
    : Array.from({ length: 7 }, (_, i) => ({ value: String(i + 1), label: weekdayName(i + 1) }));

function Fields({ recurring: r, onDone }: { recurring: Recurring; onDone: () => void }) {
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const [amount, setAmount] = useState(amountText(r.amountCents));
  const [payee, setPayee] = useState(r.payee ?? '');
  const [categoryId, setCategoryId] = useState(r.categoryId ?? '');
  const [accountId, setAccountId] = useState(r.accountId);
  const [toAccountId, setToAccountId] = useState(r.toAccountId ?? '');
  const [schedule, setSchedule] = useState<Schedule>(r.schedule);
  const [day, setDay] = useState(r.day);
  const [amountError, setAmountError] = useState<string | null>(null);

  const listed = (accounts ?? []).filter((a) => !a.archived || a.id === r.accountId);
  const kind = categoryKindFor(r.kind);
  const pickable = (kind == null ? [] : tree?.listed[kind] ?? []).flatMap((n) => [
    { value: n.id, label: n.name },
    ...n.subcategories.map((s) => ({ value: s.id, label: `${n.name} › ${s.name}` })),
  ]);
  const currency = listed.find((a) => a.id === accountId)?.currency ?? 'MYR';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = readAmount(amount);
    setAmountError('error' in typed ? typed.error : null);
    if ('error' in typed) return;
    const update: Extract<LedgerChange, { op: 'updateRecurring' }> = {
      op: 'updateRecurring',
      id: r.id,
    };
    if (typed.cents !== r.amountCents) update.amountCents = typed.cents;
    const nextPayee = readOptionalText(payee, MAX_PAYEE) ?? null;
    if (nextPayee !== r.payee) update.payee = nextPayee;
    if (r.kind !== 'transfer' && categoryId !== r.categoryId) update.categoryId = categoryId;
    if (accountId !== r.accountId) update.accountId = accountId;
    if (r.kind === 'transfer' && toAccountId !== r.toAccountId) update.toAccountId = toAccountId;
    if (schedule !== r.schedule || day !== r.day) {
      // From the occurrence it was next due on, the first the new schedule falls on
      Object.assign(update, { schedule, day, nextDue: onOrAfter(schedule, day, r.nextDue) });
    }
    if (Object.keys(update).length > 2) change(update);
    onDone();
  };

  const stop = () => {
    change({ op: 'archiveRecurring', id: r.id, archived: true });
    onDone();
    showUndo(`Stopped repeating ${recurringName(r, categories ?? [])}`, () =>
      change({ op: 'archiveRecurring', id: r.id, archived: false }),
    );
  };

  return (
    <form
      className={classes.form}
      onSubmit={submit}
      noValidate
    >
      <TextInput
        label="Amount"
        inputMode="decimal"
        leftSection={<span>{currencySymbol(currency)}</span>}
        value={amount}
        onChange={(e) => setAmount(e.currentTarget.value)}
        error={amountError}
        autoComplete="off"
      />
      <TextInput
        label={PAYEE_LABELS[r.kind]}
        value={payee}
        onChange={(e) => setPayee(e.currentTarget.value)}
        maxLength={MAX_PAYEE}
        autoComplete="off"
      />
      {r.kind !== 'transfer' && (
        <NativeSelect
          label="Category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.currentTarget.value)}
          data={pickable}
        />
      )}
      <NativeSelect
        label={r.kind === 'transfer' ? 'From' : 'Account'}
        value={accountId}
        onChange={(e) => setAccountId(e.currentTarget.value)}
        data={listed.map((a) => ({ value: a.id, label: a.name }))}
      />
      {r.kind === 'transfer' && (
        <NativeSelect
          label="To"
          value={toAccountId}
          onChange={(e) => setToAccountId(e.currentTarget.value)}
          data={listed
            .filter((a) => a.id !== accountId)
            .map((a) => ({ value: a.id, label: a.name }))}
        />
      )}
      <NativeSelect
        label="Repeats"
        value={schedule}
        onChange={(e) => {
          const next = e.currentTarget.value as Schedule;
          setSchedule(next);
          setDay((d) => (next === 'weekly' ? Math.min(d, 7) : d));
        }}
        data={[
          { value: 'monthly', label: 'Monthly' },
          { value: 'weekly', label: 'Weekly' },
        ]}
      />
      <NativeSelect
        label={schedule === 'monthly' ? 'On day' : 'On'}
        value={String(day)}
        onChange={(e) => setDay(Number(e.currentTarget.value))}
        data={dayOptions(schedule)}
      />
      <div className={classes.actions}>
        <Button
          variant="subtle"
          color="red"
          leftSection={<StopCircle size={16} />}
          onClick={stop}
        >
          Stop repeating
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
