import { Button, NativeSelect, SegmentedControl, TextInput } from '@mantine/core';
import type { FormEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { LedgerChange, Transaction } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import { MAX_NOTE, MAX_PAYEE, categoryKindFor, readOptionalText } from '@shared/ledger';
import { nextAfter } from '@shared/recurring';
import { MAX_TYPED_CENTS } from '@shared/rates';
import { addAgain, change } from '../../ledger/ledger';
import { useAccounts, useCategories, useWholeLedger } from '../../ledger/useLedger';
import { useProfile, useCurrency } from '../../profile/ProfileContext';
import { clockText, isPastDay, toDateInput } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import { sendEdit, sendsAmount, useEntryCurrency } from '../common/entry-currency';
import MainAmount from '../common/MainAmount';
import { rateLine, typedAmount } from '../common/typed-amount';
import { showUndo } from '../common/undo-toast';
import { amountText, readAmount, transactionSummary } from '../entry/entry-text';
import Key from '../ui/Key';
import { DownIcon } from '../ui/icons';
import { SIGNS, fullDay, headlineAmount, headlinePrefix } from './activity-text';
import classes from './Activity.module.css';

/** Whole cents as typed figures, with both decimals: 28900 is "289.00" */
const centsText = (cents: number) =>
  `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

const WAYS = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

// One entry, to change or delete: beside the register on a computer, in a sheet on phones
// and tablets. Beside the register (R-Desk-Activity) its payee, day and amount are typed
// where they're shown, at the top, and the fields under them are the rest. Its day and amount as they're saved, which way it went, then what can be
// changed: the amount, the category (or, for a transfer, the account it went to), the
// account, the day (and its time, when Ask for a time is on or it has one), the payee and
// the note. Save (or Enter) sends only what changed, through
// the ledger; Delete takes it out, with Undo. An entry Scheduled added at an amount that
// changes says so, with the amount ready to type: Save confirms it as it is, or at the
// amount the bill came to, which (on the item's latest entry) is the item's amount next time.
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
  const homeCurrency = useCurrency();
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const { data: ledger } = useWholeLedger();
  const today = toDateInput(new Date());
  const toCheck = editing.scheduled?.toCheck === true;
  const amountField = useRef<HTMLInputElement>(null);
  // Opened to check its amount, the amount is ready to type in
  useEffect(() => {
    if (!toCheck) return;
    const focus = setTimeout(() => amountField.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, [toCheck]);
  // In the currency it was typed in, which can be changed
  const {
    home,
    typedIn,
    setTypedIn,
    options: currencies,
    quote,
    typedCents,
  } = useEntryCurrency(editing);
  // Beside the register it reads as its headline, cents and all ("289.00")
  const [amount, setAmount] = useState(
    title != null ? centsText(typedCents) : amountText(typedCents),
  );
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
    Partial<Record<'amount' | 'date' | 'category' | 'to' | 'currency', string>>
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
  const currency = account?.currency ?? homeCurrency;
  // Beside the register: its payee, day and amount typed where they're shown, each refusal
  // said aloud and tied to its field
  const inline = title != null;
  const errorIds = { date: useId(), amount: useId() };
  const chevron = (
    <DownIcon
      size={16}
      aria-hidden
    />
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = readAmount(amount, typedIn === home ? undefined : MAX_TYPED_CENTS);
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
    if (sendsAmount(editing, typed.cents, typedIn, home, date !== editing.date)) {
      update.amountCents = typed.cents;
    }
    // Saved as it is, an amount to check is confirmed; a new amount confirms it too
    if (toCheck && !('amountCents' in update)) update.toCheck = false;
    // The amount the bill came to is the item's amount next time, when its amount changes
    // and this is its latest entry
    const mark = editing.scheduled;
    const item = ledger?.recurring?.find((r) => r.id === mark?.recurringId);
    const nextTime =
      typedIn === home &&
      mark != null &&
      item != null &&
      !item.archived &&
      item.amountVaries === true &&
      'amountCents' in update &&
      update.amountCents !== item.amountCents &&
      nextAfter(item.schedule, item.day, mark.due) === item.nextDue;
    const more: LedgerChange[] =
      nextTime && update.amountCents != null
        ? [{ op: 'updateRecurring', id: item.id, amountCents: update.amountCents }]
        : [];
    if (!sendEdit(update, more, { typedIn, home, quote })) {
      setErrors({ currency: `Needs a rate for ${typedIn}. Connect to fetch one.` });
      return;
    }
    onSaved?.();
  };

  const remove = () => {
    change({ op: 'removeTransaction', id: editing.id });
    onDeleted();
    const what = transactionSummary(editing, accounts ?? [], categories ?? []);
    showUndo(`Deleted ${formatMoney(editing.amountCents, currency)}, ${what}`, () =>
      addAgain(editing),
    );
  };

  return (
    <form
      className={classes.editor}
      onSubmit={submit}
      noValidate
    >
      {inline ? (
        <>
          <div className={classes.editorHead}>
            <h2 className="sr-only">{title}</h2>
            <input
              className={`${classes.editorTitle} ${classes.inlineField}`}
              aria-label="Payee"
              placeholder={title}
              value={payee}
              maxLength={MAX_PAYEE}
              autoComplete="off"
              onChange={(e) => setPayee(e.currentTarget.value)}
            />
            {/* The day as it's written, over the field that changes it */}
            <label className={`${classes.muted} ${classes.dayField}`}>
              <span aria-hidden>
                {isPastDay(date) ? fullDay(date, today) : 'Pick a day'}
                {editing.time != null && `, ${clockText(editing.time)}`}
              </span>
              <input
                type="date"
                aria-label="Date"
                aria-invalid={errors.date != null || undefined}
                aria-describedby={errors.date != null ? errorIds.date : undefined}
                value={date}
                min="2000-01-01"
                max={today}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker();
                  } catch {
                    // Without a picker, the day is typed
                  }
                }}
                onChange={(e) => setDate(e.currentTarget.value)}
              />
            </label>
          </div>
          {errors.date != null && (
            <p
              id={errorIds.date}
              role="alert"
              className={classes.fieldError}
            >
              {errors.date}
            </p>
          )}
          <label
            className={`${classes.headline} sf-tabular`}
            data-kind={kind}
          >
            <span>
              {typedIn === home ? headlinePrefix(kind, currency) : `${SIGNS[kind]}${typedIn}`}
            </span>{' '}
            <input
              ref={amountField}
              className={classes.inlineField}
              aria-label="Amount"
              aria-invalid={errors.amount != null || undefined}
              aria-describedby={errors.amount != null ? errorIds.amount : undefined}
              inputMode="decimal"
              autoComplete="off"
              data-autofocus={toCheck || undefined}
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
            />
          </label>
          {errors.amount != null && (
            <p
              id={errorIds.amount}
              role="alert"
              className={classes.fieldError}
            >
              {errors.amount}
            </p>
          )}
        </>
      ) : (
        <>
          <div className={classes.editorHead}>
            <span className={classes.muted}>
              {fullDay(editing.date, today)}
              {editing.time != null && `, ${clockText(editing.time)}`}
            </span>
          </div>
          <p
            className={`${classes.headline} sf-tabular`}
            data-kind={editing.kind}
          >
            {typedAmount(editing, SIGNS[editing.kind]) ?? headlineAmount(editing, currency)}
            <MainAmount
              t={editing}
              currency={currency}
            />
          </p>
        </>
      )}
      <SegmentedControl
        aria-label="Which way"
        fullWidth
        value={kind}
        onChange={(value) => setKind(value as TransactionKind)}
        data={WAYS}
      />
      {currencies.length > 1 && (
        <NativeSelect
          label="Currency"
          value={typedIn}
          onChange={(e) => setTypedIn(e.currentTarget.value)}
          data={currencies}
          error={errors.currency}
          rightSection={chevron}
          rightSectionWidth={44}
        />
      )}
      {editing.original != null && <p className={classes.muted}>{rateLine(editing, currency)}</p>}
      {toCheck && (
        <p className={classes.muted}>
          {`Added at ${formatMoney(editing.amountCents, currency)} from Scheduled, for you to check`}
        </p>
      )}
      {!inline && (
        <TextInput
          ref={amountField}
          label="Amount"
          inputMode="decimal"
          autoComplete="off"
          data-autofocus={toCheck || undefined}
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          error={errors.amount}
        />
      )}
      {transfer ? (
        <NativeSelect
          label="To"
          value={
            destinations.some((a) => a.id === toAccountId) ? toAccountId : destinations[0]?.id ?? ''
          }
          onChange={(e) => setToAccountId(e.currentTarget.value)}
          data={destinations.map((a) => ({ value: a.id, label: a.name }))}
          error={errors.to}
          rightSection={chevron}
          rightSectionWidth={44}
        />
      ) : (
        <NativeSelect
          label="Category"
          value={categoryId ?? ''}
          onChange={(e) => setPicked((now) => ({ ...now, [kind]: e.currentTarget.value }))}
          data={[{ value: '', label: 'Pick a category', disabled: true }, ...options]}
          error={errors.category}
          rightSection={chevron}
          rightSectionWidth={44}
        />
      )}
      <NativeSelect
        label={transfer ? 'From' : 'Account'}
        value={account?.id ?? ''}
        onChange={(e) => setAccountId(e.currentTarget.value)}
        data={listed.map((a) => ({ value: a.id, label: a.name }))}
        rightSection={chevron}
        rightSectionWidth={44}
      />
      {!inline && (
        <TextInput
          type="date"
          label="Date"
          value={date}
          min="2000-01-01"
          max={today}
          onChange={(e) => setDate(e.currentTarget.value)}
          error={errors.date}
        />
      )}
      {showsTime && (
        <TextInput
          type="time"
          label="Time"
          value={time}
          onChange={(e) => setTime(e.currentTarget.value)}
        />
      )}
      {!inline && (
        <TextInput
          label="Payee"
          value={payee}
          maxLength={MAX_PAYEE}
          autoComplete="off"
          onChange={(e) => setPayee(e.currentTarget.value)}
        />
      )}
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
          size={inline ? 'xs' : undefined}
          className={`sf-danger ${classes.deleteButton}`}
          onClick={remove}
        >
          Delete
        </Button>
        <Button
          type="submit"
          size={inline ? 'xs' : undefined}
          rightSection={<Key>Enter</Key>}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
