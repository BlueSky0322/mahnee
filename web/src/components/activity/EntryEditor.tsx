import { Button, NativeSelect, SegmentedControl, TextInput } from '@mantine/core';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { LedgerChange, Transaction } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import {
  DEFAULT_CURRENCY,
  MAX_NOTE,
  MAX_PAYEE,
  categoryKindFor,
  readOptionalText,
} from '@shared/ledger';
import { change } from '../../ledger/ledger';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { clockText, isPastDay, toDateInput } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import { showUndo } from '../common/undo-toast';
import { amountText, readAmount, transactionSummary } from '../entry/entry-text';
import Key from '../ui/Key';
import { fullDay, headlineAmount } from './activity-text';
import classes from './Activity.module.css';

const WAYS = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

// One entry, to change or delete: beside the register on a computer, in a sheet on phones
// and tablets. Its day and amount as they're saved, which way it went, then what can be
// changed: the amount, the category (or, for a transfer, the account it went to), the
// account, the day (and its time, when Ask for a time is on or it has one), the payee and
// the note. Save (or Enter) sends only what changed, through
// the ledger; Delete takes it out, with Undo.
export default function EntryEditor({
  transaction: editing,
  title,
  onDeleted,
  onSaved,
}: {
  transaction: Transaction;
  /** The entry's name, drawn as the pane's heading; a sheet has its own */
  title?: string;
  onDeleted: () => void;
  onSaved?: () => void;
}) {
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const today = toDateInput(new Date());
  const [amount, setAmount] = useState(amountText(editing.amountCents));
  const [kind, setKind] = useState<TransactionKind>(editing.kind);
  const [accountId, setAccountId] = useState(editing.accountId);
  const [toAccountId, setToAccountId] = useState(editing.toAccountId ?? '');
  const [picked, setPicked] = useState<Partial<Record<TransactionKind, string>>>(
    editing.categoryId == null ? {} : { [editing.kind]: editing.categoryId },
  );
  const [date, setDate] = useState(editing.date);
  const [time, setTime] = useState(editing.time ?? '');
  const asksForTime = useProfile().profile?.settings.askForTime === true;
  const showsTime = asksForTime || editing.time != null;
  const [payee, setPayee] = useState(editing.payee ?? '');
  const [note, setNote] = useState(editing.note ?? '');
  const [errors, setErrors] = useState<
    Partial<Record<'amount' | 'date' | 'category' | 'to', string>>
  >({});

  // What can be picked: listed accounts and categories, and the ones it's on already
  const listed = (accounts ?? []).filter(
    (a) => !a.archived || a.id === editing.accountId || a.id === editing.toAccountId,
  );
  const account = listed.find((a) => a.id === accountId) ?? listed[0];
  const destinations = listed.filter((a) => a.id !== account?.id);
  const transfer = kind === 'transfer';
  const categoryKind = categoryKindFor(kind);
  const nodes = categoryKind == null ? [] : tree?.listed[categoryKind] ?? [];
  const options = nodes.flatMap((node) => [
    { value: node.id, label: node.name },
    ...node.subcategories.map((c) => ({ value: c.id, label: `${node.name} › ${c.name}` })),
  ]);
  const categoryId = categoryKind == null ? null : picked[kind] ?? '';
  const currency = account?.currency ?? DEFAULT_CURRENCY;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = readAmount(amount);
    const wrong: typeof errors = {};
    if ('error' in typed) wrong.amount = typed.error;
    if (!isPastDay(date)) wrong.date = 'Pick a day from 2000 up to today';
    if (!transfer && !options.some((o) => o.value === categoryId))
      wrong.category = 'Pick a category';
    const to = transfer ? destinations.find((a) => a.id === toAccountId) ?? destinations[0] : null;
    if (transfer && to == null) wrong.to = 'Add another account to move money to';
    setErrors(wrong);
    if ('error' in typed || Object.keys(wrong).length > 0 || account == null) return;
    const fields = {
      kind,
      accountId: account.id,
      toAccountId: to?.id ?? null,
      amountCents: typed.cents,
      categoryId: transfer ? null : categoryId,
      payee: readOptionalText(payee, MAX_PAYEE) ?? null,
      note: readOptionalText(note, MAX_NOTE) ?? null,
      date,
      ...(showsTime && { time: time === '' ? null : time }),
    };
    // Only what changed is sent; a new kind always comes with its category and where it goes
    const update: Extract<LedgerChange, { op: 'updateTransaction' }> = {
      op: 'updateTransaction',
      id: editing.id,
    };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const goesWithKind = key === 'categoryId' || key === 'toAccountId';
      if (fields[key] !== (editing[key] ?? null) || (goesWithKind && kind !== editing.kind)) {
        Object.assign(update, { [key]: fields[key] });
      }
    }
    if (Object.keys(update).length > 2) change(update);
    onSaved?.();
  };

  const remove = () => {
    change({ op: 'removeTransaction', id: editing.id });
    onDeleted();
    const { createdAt: _createdAt, ...again } = editing;
    const what = transactionSummary(editing, accounts ?? [], categories ?? []);
    showUndo(`Deleted ${formatMoney(editing.amountCents, currency)}, ${what}`, () =>
      change({ op: 'addTransaction', transaction: again }),
    );
  };

  return (
    <form
      className={classes.editor}
      onSubmit={submit}
      noValidate
    >
      <div className={classes.editorHead}>
        {title != null && <h2 className={classes.editorTitle}>{title}</h2>}
        <span className={classes.muted}>
          {fullDay(editing.date, today)}
          {editing.time != null && `, ${clockText(editing.time)}`}
        </span>
      </div>
      <p
        className={`${classes.headline} sf-tabular`}
        data-kind={editing.kind}
      >
        {headlineAmount(editing, currency)}
      </p>
      <SegmentedControl
        aria-label="Which way"
        fullWidth
        value={kind}
        onChange={(value) => setKind(value as TransactionKind)}
        data={WAYS}
      />
      <TextInput
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(e) => setAmount(e.currentTarget.value)}
        error={errors.amount}
      />
      {transfer ? (
        <NativeSelect
          label="To"
          value={
            destinations.some((a) => a.id === toAccountId) ? toAccountId : destinations[0]?.id ?? ''
          }
          onChange={(e) => setToAccountId(e.currentTarget.value)}
          data={destinations.map((a) => ({ value: a.id, label: a.name }))}
          error={errors.to}
        />
      ) : (
        <NativeSelect
          label="Category"
          value={categoryId ?? ''}
          onChange={(e) => setPicked((now) => ({ ...now, [kind]: e.currentTarget.value }))}
          data={[{ value: '', label: 'Pick a category', disabled: true }, ...options]}
          error={errors.category}
        />
      )}
      <NativeSelect
        label={transfer ? 'From' : 'Account'}
        value={account?.id ?? ''}
        onChange={(e) => setAccountId(e.currentTarget.value)}
        data={listed.map((a) => ({ value: a.id, label: a.name }))}
      />
      <TextInput
        type="date"
        label="Date"
        value={date}
        min="2000-01-01"
        max={today}
        onChange={(e) => setDate(e.currentTarget.value)}
        error={errors.date}
      />
      {showsTime && (
        <TextInput
          type="time"
          label="Time"
          value={time}
          onChange={(e) => setTime(e.currentTarget.value)}
        />
      )}
      <TextInput
        label="Payee"
        value={payee}
        maxLength={MAX_PAYEE}
        autoComplete="off"
        onChange={(e) => setPayee(e.currentTarget.value)}
      />
      <TextInput
        label="Note"
        value={note}
        maxLength={MAX_NOTE}
        autoComplete="off"
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <div className={classes.editorActions}>
        <Button
          variant="subtle"
          className="sf-danger"
          onClick={remove}
        >
          Delete
        </Button>
        <Button
          type="submit"
          rightSection={<Key>Enter</Key>}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
