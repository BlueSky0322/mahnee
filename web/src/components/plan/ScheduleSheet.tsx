import { Button, NativeSelect, SegmentedControl, TextInput } from '@mantine/core';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { LedgerChange, Recurring } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import { DEFAULT_CURRENCY, MAX_PAYEE, categoryKindFor, readOptionalText } from '@shared/ledger';
import { fallsOn, nextAfter, onOrAfter } from '@shared/recurring';
import { change } from '../../ledger/ledger';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { currencySymbol } from '../../utils/money';
import { showUndo } from '../common/undo-toast';
import { amountText, readAmount } from '../entry/entry-text';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './Scheduled.module.css';
import { REPEATS, itemTitle, nextLine, repeatsLabel } from './scheduled-text';

/** What a new schedule starts with: a common one, or a payment into a card */
export interface Prefill {
  kind?: TransactionKind;
  payee?: string | null;
  categoryId?: string | null;
  toAccountId?: string | null;
}

/** The item being changed, or a new one with what it starts with; null while closed */
export type Opened = { item: Recurring } | { prefill: Prefill } | null;

const KINDS = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

const EACH_TIME = [
  { value: 'same', label: 'Same amount' },
  { value: 'changes', label: 'It changes' },
];

// One scheduled item, to change or stop (R-Bill-Edit, R-Bill-Edit-Tnb), or a new one: Cancel
// and Save; its name, the amount and whether it's the same each time or changes ("last
// time"); where it's from (and, for a transfer, to), what it's for, when it repeats; for an
// item, what happens next, and Stop scheduling (with Undo); for a new one, which way it goes
// and its first day. Everything is saved through the ledger, shown at once.
export default function ScheduleSheet({
  opened,
  onClose,
}: {
  opened: Opened;
  onClose: () => void;
}) {
  const { categories } = useCategories();
  const { accounts } = useAccounts();
  // What was opened stays drawn while the sheet closes, rather than emptying as it goes
  const [shown, setShown] = useState(opened);
  if (opened != null && opened !== shown) setShown(opened);
  const drawn = opened ?? shown;
  const title =
    drawn == null || !('item' in drawn)
      ? 'New schedule'
      : itemTitle(drawn.item, accounts ?? [], categories ?? [], false);
  return (
    <ResponsiveDialog
      opened={opened != null}
      onClose={onClose}
      title={title}
      width={480}
      // Its own Cancel and Save are at its foot
      closeLabel={null}
    >
      {drawn != null && (
        <Fields
          key={'item' in drawn ? drawn.item.id : 'new'}
          opened={drawn}
          title={title}
          onDone={onClose}
        />
      )}
    </ResponsiveDialog>
  );
}

function Fields({
  opened,
  title,
  onDone,
}: {
  opened: NonNullable<Opened>;
  title: string;
  onDone: () => void;
}) {
  const { accounts } = useAccounts();
  const { tree } = useCategories();
  const today = toDateInput(new Date());
  const item = 'item' in opened ? opened.item : null;
  const prefill = 'prefill' in opened ? opened.prefill : {};
  const listed = (accounts ?? []).filter(
    (a) => !a.archived || a.id === item?.accountId || a.id === item?.toAccountId,
  );
  const [kind, setKind] = useState<TransactionKind>(item?.kind ?? prefill.kind ?? 'expense');
  const [payee, setPayee] = useState(item?.payee ?? prefill.payee ?? '');
  const [amount, setAmount] = useState(item == null ? '' : amountText(item.amountCents));
  const [varies, setVaries] = useState(item?.amountVaries === true);
  const toFirst = listed.find((a) => a.id !== prefill.toAccountId);
  const [accountId, setAccountId] = useState(item?.accountId ?? toFirst?.id ?? '');
  const [toAccountId, setToAccountId] = useState(item?.toAccountId ?? prefill.toAccountId ?? '');
  const categoryKind = categoryKindFor(kind);
  const options = (categoryKind == null ? [] : tree?.listed[categoryKind] ?? []).flatMap((n) => [
    { value: n.id, label: n.name },
    ...n.subcategories.map((s) => ({ value: s.id, label: `${n.name} › ${s.name}` })),
  ]);
  const [picked, setPicked] = useState<Partial<Record<TransactionKind, string>>>(() => {
    const id = item?.categoryId ?? prefill.categoryId;
    return id == null ? {} : { [item?.kind ?? prefill.kind ?? 'expense']: id };
  });
  const categoryId = categoryKind == null ? null : picked[kind] ?? options[0]?.value ?? '';
  const [repeats, setRepeats] = useState(
    item == null ? 'monthly:1' : `${item.schedule}:${item.day}`,
  );
  const [schedule, dayText] = repeats.split(':') as [Recurring['schedule'], string];
  const day = Number(dayText);
  const firstAfterToday = (s: Recurring['schedule'], d: number) => nextAfter(s, d, today);
  const [firstOn, setFirstOn] = useState(() => firstAfterToday(schedule, day));
  const [errors, setErrors] = useState<Partial<Record<'amount' | 'firstOn' | 'to', string>>>({});

  const transfer = kind === 'transfer';
  const destinations = listed.filter((a) => a.id !== accountId);
  const to = transfer
    ? destinations.find((a) => a.id === toAccountId) ?? destinations[0] ?? null
    : null;
  const currency = listed.find((a) => a.id === accountId)?.currency ?? DEFAULT_CURRENCY;
  const typedCents = (() => {
    const typed = readAmount(amount);
    return 'error' in typed ? item?.amountCents ?? 0 : typed.cents;
  })();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = readAmount(amount);
    const wrong: typeof errors = {};
    if ('error' in typed) wrong.amount = typed.error;
    if (transfer && to == null) wrong.to = 'Add another account to move money to';
    if (item == null && (!fallsOn(schedule, day, firstOn) || firstOn <= today)) {
      wrong.firstOn = 'Pick a day after today that it falls on';
    }
    setErrors(wrong);
    if ('error' in typed || Object.keys(wrong).length > 0) return;
    const name = readOptionalText(payee, MAX_PAYEE) ?? null;
    if (item == null) {
      change({
        op: 'addRecurring',
        recurring: {
          id: newId(),
          kind,
          accountId,
          toAccountId: to?.id ?? null,
          amountCents: typed.cents,
          categoryId: transfer ? null : categoryId,
          payee: name,
          schedule,
          day,
          startDate: today,
          nextDue: firstOn,
          amountVaries: varies,
        },
      });
      onDone();
      return;
    }
    const update: Extract<LedgerChange, { op: 'updateRecurring' }> = {
      op: 'updateRecurring',
      id: item.id,
    };
    if (typed.cents !== item.amountCents) update.amountCents = typed.cents;
    if (name !== item.payee) update.payee = name;
    if (varies !== (item.amountVaries === true)) update.amountVaries = varies;
    if (!transfer && categoryId !== item.categoryId) update.categoryId = categoryId;
    if (accountId !== item.accountId) update.accountId = accountId;
    if (transfer && to != null && to.id !== item.toAccountId) update.toAccountId = to.id;
    if (schedule !== item.schedule || day !== item.day) {
      // From the occurrence it was next due on, the first the new schedule falls on
      Object.assign(update, { schedule, day, nextDue: onOrAfter(schedule, day, item.nextDue) });
    }
    if (Object.keys(update).length > 2) change(update);
    onDone();
  };

  const stop = () => {
    if (item == null) return;
    change({ op: 'archiveRecurring', id: item.id, archived: true });
    onDone();
    showUndo(`Stopped scheduling ${title}`, () =>
      change({ op: 'archiveRecurring', id: item.id, archived: false }),
    );
  };

  return (
    <form
      className={classes.form}
      onSubmit={submit}
      noValidate
    >
      {item == null && (
        <SegmentedControl
          aria-label="What it is"
          fullWidth
          value={kind}
          onChange={(value) => setKind(value as TransactionKind)}
          data={KINDS}
        />
      )}
      <TextInput
        label="Name"
        value={payee}
        maxLength={MAX_PAYEE}
        autoComplete="off"
        onChange={(e) => setPayee(e.currentTarget.value)}
      />
      <TextInput
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        leftSection={<span>{currencySymbol(currency)}</span>}
        description={varies ? 'last time' : undefined}
        value={amount}
        onChange={(e) => setAmount(e.currentTarget.value)}
        error={errors.amount}
      />
      <div className={classes.field}>
        <span className={classes.fieldLabel}>Each time</span>
        <SegmentedControl
          aria-label="Amount each time"
          fullWidth
          value={varies ? 'changes' : 'same'}
          onChange={(value) => setVaries(value === 'changes')}
          data={EACH_TIME}
        />
      </div>
      <NativeSelect
        label={kind === 'income' ? 'Into' : 'From'}
        value={accountId}
        onChange={(e) => setAccountId(e.currentTarget.value)}
        data={listed.map((a) => ({ value: a.id, label: a.name }))}
      />
      {transfer ? (
        <NativeSelect
          label="To"
          value={to?.id ?? ''}
          onChange={(e) => setToAccountId(e.currentTarget.value)}
          data={destinations.map((a) => ({ value: a.id, label: a.name }))}
          error={errors.to}
        />
      ) : (
        <NativeSelect
          label="For"
          value={categoryId ?? ''}
          onChange={(e) => setPicked((now) => ({ ...now, [kind]: e.currentTarget.value }))}
          data={options}
        />
      )}
      <NativeSelect
        label="Repeats"
        value={repeats}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setRepeats(next);
          const [s, d] = next.split(':');
          setFirstOn(firstAfterToday(s as Recurring['schedule'], Number(d)));
        }}
        data={REPEATS.map((r) => ({ value: `${r.schedule}:${r.day}`, label: repeatsLabel(r) }))}
      />
      {item == null ? (
        <TextInput
          type="date"
          label="First on"
          value={firstOn}
          min={today}
          onChange={(e) => setFirstOn(e.currentTarget.value)}
          error={errors.firstOn}
        />
      ) : (
        <div className={classes.field}>
          <span className={classes.fieldLabel}>Next</span>
          <span className={classes.next}>
            {nextLine(
              { ...item, amountCents: typedCents, amountVaries: varies },
              accounts ?? [],
              today,
            )}
          </span>
        </div>
      )}
      <div className={classes.actions}>
        <Button
          variant="default"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
      {item != null && (
        <Button
          variant="subtle"
          className="sf-danger"
          onClick={stop}
        >
          {`Stop scheduling ${title}`}
        </Button>
      )}
    </form>
  );
}
