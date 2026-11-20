import { Button, SegmentedControl } from '@mantine/core';
import { useCurrency } from '../../profile/ProfileContext';
import type { FormEvent, ReactNode } from 'react';
import { useId, useState } from 'react';
import type { LedgerChange, Recurring } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import { MAX_PAYEE, categoryKindFor, readOptionalText } from '@shared/ledger';
import { fallsOn, nextAfter, onOrAfter } from '@shared/recurring';
import { change } from '../../ledger/ledger';
import { categoryColour } from '../../utils/category-colour';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { currencySymbol } from '../../utils/money';
import { showUndo } from '../common/undo-toast';
import { readAmount } from '../entry/entry-text';
import ResponsiveDialog, { DialogTitle } from '../ui/ResponsiveDialog';
import Picker from '../ui/Picker';
import RepeatsPicker from '../ui/RepeatsPicker';
import classes from './Scheduled.module.css';
import { itemTitle, nextLine, repeatsLabel } from './scheduled-text';

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

// One scheduled item, to change or stop (R-Bill-Edit, R-Bill-Edit-Tnb), or a new one: Cancel,
// its name as the title (typed over to rename it) and Save; then one card of rows: the
// amount and whether it's the same each time or changes ("last time"), where it's from (and,
// for a transfer, to), what it's for, when it repeats; for an item, what happens next, and
// Stop scheduling (with Undo); for a new one, which way it goes, its name and its first day.
// Everything is saved through the ledger, shown at once.
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
      width={520}
      top={96}
      grouped
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

/** An amount as the sheet shows it to change: "189.00", "54.90", always with its cents */
const twoPlaces = (cents: number) =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** One row of the card: its name at the left, what it is beside it */
function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={classes.frow}>
      {htmlFor == null ? (
        <span className={classes.k}>{label}</span>
      ) : (
        <label
          htmlFor={htmlFor}
          className={classes.k}
        >
          {label}
        </label>
      )}
      {children}
    </div>
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
  const homeCurrency = useCurrency();
  const { accounts } = useAccounts();
  const { tree, categories } = useCategories();
  const ids = { amount: useId(), name: useId(), firstOn: useId() };
  const today = toDateInput(new Date());
  const item = 'item' in opened ? opened.item : null;
  const prefill = 'prefill' in opened ? opened.prefill : {};
  const listed = (accounts ?? []).filter(
    (a) => !a.archived || a.id === item?.accountId || a.id === item?.toAccountId,
  );
  const [kind, setKind] = useState<TransactionKind>(item?.kind ?? prefill.kind ?? 'expense');
  const [payee, setPayee] = useState(item?.payee ?? prefill.payee ?? '');
  const [amount, setAmount] = useState(item == null ? '' : twoPlaces(item.amountCents));
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
  const currency = listed.find((a) => a.id === accountId)?.currency ?? homeCurrency;
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

  // An item called by its name is renamed in its title; a new one, and one called by its
  // category or where it goes ("Salary", "Top-up to Wallet"), has a Name row
  const named = item != null && item.payee != null && item.payee === title;
  const errorList = [errors.amount, errors.to, errors.firstOn].filter((e) => e != null);
  return (
    <form
      className={classes.form}
      onSubmit={submit}
      noValidate
    >
      <div className={classes.sheetHead}>
        <Button
          variant="light"
          size="xs"
          className={`${classes.cancel} ${classes.small}`}
          onClick={onDone}
        >
          Cancel
        </Button>
        <DialogTitle className={classes.sheetTitle}>
          {!named ? (
            title
          ) : (
            <input
              aria-label="Name"
              className={classes.titleInput}
              value={payee}
              placeholder={title}
              maxLength={MAX_PAYEE}
              autoComplete="off"
              onChange={(e) => setPayee(e.currentTarget.value)}
            />
          )}
        </DialogTitle>
        <Button
          type="submit"
          size="xs"
          className={classes.small}
        >
          Save
        </Button>
      </div>
      {item == null && (
        <SegmentedControl
          aria-label="What it is"
          fullWidth
          className={classes.kinds}
          value={kind}
          onChange={(value) => setKind(value as TransactionKind)}
          data={KINDS}
        />
      )}
      <div className={classes.fields}>
        {!named && (
          <Row
            label="Name"
            htmlFor={ids.name}
          >
            <input
              id={ids.name}
              className={classes.input}
              value={payee}
              maxLength={MAX_PAYEE}
              autoComplete="off"
              onChange={(e) => setPayee(e.currentTarget.value)}
            />
          </Row>
        )}
        <Row
          label="Amount"
          htmlFor={ids.amount}
        >
          <span className={`${classes.v} sf-tabular`}>
            <span aria-hidden>{currencySymbol(currency)}</span>
            <input
              id={ids.amount}
              className={classes.input}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={errors.amount != null || undefined}
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
            />
          </span>
          {varies && <span className={classes.amountNote}>last time</span>}
        </Row>
        <Row label="Each time">
          <SegmentedControl
            aria-label="Amount each time"
            className={classes.each}
            value={varies ? 'changes' : 'same'}
            onChange={(value) => setVaries(value === 'changes')}
            data={EACH_TIME}
          />
        </Row>
        <Picker
          look="row"
          className={classes.frow}
          label={kind === 'income' ? 'Into' : 'From'}
          value={accountId}
          onChange={setAccountId}
          options={listed.map((a) => ({ value: a.id, label: a.name }))}
        />
        {transfer ? (
          <Picker
            look="row"
            className={classes.frow}
            label="To"
            value={to?.id ?? ''}
            onChange={setToAccountId}
            options={destinations.map((a) => ({ value: a.id, label: a.name }))}
          />
        ) : (
          <Picker
            look="row"
            className={classes.frow}
            label="For"
            value={categoryId ?? ''}
            onChange={(value) => setPicked((now) => ({ ...now, [kind]: value }))}
            options={options.map((o) => ({ ...o, dot: categoryColour(categories ?? [], o.value) }))}
          />
        )}
        <RepeatsPicker
          className={classes.frow}
          label="Repeats"
          schedule={schedule}
          day={day}
          shown={repeatsLabel({ schedule, day })}
          onChange={(s, d) => {
            setRepeats(`${s}:${d}`);
            setFirstOn(firstAfterToday(s, d));
          }}
        />
        {item == null && (
          <Row
            label="First on"
            htmlFor={ids.firstOn}
          >
            <input
              id={ids.firstOn}
              type="date"
              className={classes.input}
              value={firstOn}
              min={today}
              aria-invalid={errors.firstOn != null || undefined}
              onChange={(e) => setFirstOn(e.currentTarget.value)}
            />
          </Row>
        )}
      </div>
      {errorList.length > 0 && (
        <div
          role="alert"
          className={classes.errors}
        >
          {errorList.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      {item != null && (
        <div className={classes.nextCard}>
          <b className={classes.nextTitle}>Next</b>
          <p className={classes.next}>
            {nextLine(
              { ...item, amountCents: typedCents, amountVaries: varies },
              accounts ?? [],
              today,
              currency,
            )}
          </p>
        </div>
      )}
      {item != null && (
        <Button
          variant="subtle"
          className={`sf-danger ${classes.stop}`}
          onClick={stop}
        >
          {`Stop scheduling ${title}`}
        </Button>
      )}
    </form>
  );
}
