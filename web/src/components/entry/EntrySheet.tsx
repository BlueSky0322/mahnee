import {
  Anchor,
  Button,
  Chip,
  Input,
  NativeSelect,
  SegmentedControl,
  TextInput,
  Textarea,
} from '@mantine/core';
import { CaretDown, CaretRight, Trash } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { LedgerChange, Transaction } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { DEFAULT_CURRENCY, MAX_NOTE, MAX_PAYEE, readOptionalText } from '@shared/ledger';
import { navigate } from '../../hooks/useRoute';
import { change } from '../../ledger/ledger';
import { lastUsed, rememberUsed } from '../../ledger/last-used';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { useProfile } from '../../profile/ProfileContext';
import { isPastDay, toDateInput } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { currencySymbol, formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';
import { showUndo } from '../common/undo-toast';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { amountText, readAmount } from './entry-text';
import classes from './Entry.module.css';

/** What's open: a new transaction (on `accountId` when given), or one to change */
export type OpenEntry = { transaction: null; accountId?: string } | { transaction: Transaction };

// The entry sheet: the amount first, then which way it went, the account and category
// (the ones used last, unless changed), the day, and a payee and note under More. With
// the defaults, typing the amount and Save is all it takes.
export default function EntrySheet({
  open,
  onClose,
}: {
  open: OpenEntry | null;
  onClose: () => void;
}) {
  return (
    <ResponsiveDialog
      opened={open != null}
      onClose={onClose}
      title={open?.transaction == null ? 'Add transaction' : 'Edit transaction'}
      width={480}
    >
      {open != null && (
        <Fields
          // A fresh form for each one opened
          key={open.transaction?.id ?? 'new'}
          open={open}
          onDone={onClose}
        />
      )}
    </ResponsiveDialog>
  );
}

const KIND_OPTIONS = [
  { value: 'expense', label: 'Spent' },
  { value: 'income', label: 'Received' },
];

function Fields({ open, onDone }: { open: OpenEntry; onDone: () => void }) {
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  const email = useProfile().profile?.email ?? null;
  const editing = open.transaction;
  const [remembered] = useState(() => lastUsed(email));

  const [amount, setAmount] = useState(editing ? amountText(editing.amountCents) : '');
  const [kind, setKind] = useState<CategoryKind>(editing?.kind === 'income' ? 'income' : 'expense');
  const [accountId, setAccountId] = useState<string | null>(
    editing?.accountId ?? (open.transaction == null ? open.accountId ?? null : null),
  );
  const [picked, setPicked] = useState<Partial<Record<CategoryKind, string>>>(
    editing?.categoryId != null ? { [kind]: editing.categoryId } : {},
  );
  const [date, setDate] = useState(editing?.date ?? toDateInput(new Date()));
  const [payee, setPayee] = useState(editing?.payee ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [more, setMore] = useState(editing?.payee != null || editing?.note != null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // What can be picked: listed accounts and categories, and the ones it's on already
  const listedAccounts = (accounts ?? []).filter((a) => !a.archived || a.id === editing?.accountId);
  const account =
    listedAccounts.find((a) => a.id === accountId) ??
    listedAccounts.find((a) => a.id === remembered.accountId && !a.archived) ??
    listedAccounts.find((a) => !a.archived);
  const nodes = tree?.listed[kind] ?? [];
  const pickable = nodes.flatMap((n) => [n, ...n.subcategories]);
  const isPickable = (id: string | undefined) => id != null && pickable.some((c) => c.id === id);
  const categoryId = [picked[kind], remembered.categoryIds[kind], nodes[0]?.id].find(isPickable);
  const top = nodes.find(
    (n) => n.id === categoryId || n.subcategories.some((s) => s.id === categoryId),
  );
  const currency = account?.currency ?? DEFAULT_CURRENCY;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = readAmount(amount);
    setAmountError('error' in typed ? typed.error : null);
    const dayOk = isPastDay(date);
    setDateError(dayOk ? null : 'Pick a day from 2000 up to today');
    setCategoryError(categoryId == null ? 'Pick a category' : null);
    if ('error' in typed || !dayOk || categoryId == null || account == null) return;
    const fields = {
      kind,
      accountId: account.id,
      amountCents: typed.cents,
      categoryId,
      payee: readOptionalText(payee, MAX_PAYEE) ?? null,
      note: readOptionalText(note, MAX_NOTE) ?? null,
      date,
    };

    if (editing == null) {
      change({ op: 'addTransaction', transaction: { id: newId(), ...fields } });
    } else {
      // Only what changed is sent; a new kind always comes with its category
      const update: Extract<LedgerChange, { op: 'updateTransaction' }> = {
        op: 'updateTransaction',
        id: editing.id,
      };
      for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
        if (fields[key] !== editing[key] || (key === 'categoryId' && kind !== editing.kind)) {
          Object.assign(update, { [key]: fields[key] });
        }
      }
      if (Object.keys(update).length > 2) change(update);
    }
    rememberUsed(email, { accountId: account.id, kind, categoryId });
    onDone();
  };

  const remove = () => {
    if (editing == null) return;
    change({ op: 'removeTransaction', id: editing.id });
    onDone();
    const { createdAt: _createdAt, ...again } = editing;
    showUndo(
      `Deleted ${formatMoney(editing.amountCents, currency)}, ${categoryName(categories ?? [], editing.categoryId)}`,
      () => change({ op: 'addTransaction', transaction: again }),
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
        placeholder="0.00"
        inputMode="decimal"
        size="lg"
        leftSection={<span className={classes.symbol}>{currencySymbol(currency)}</span>}
        value={amount}
        onChange={(e) => setAmount(e.currentTarget.value)}
        error={amountError}
        data-autofocus
        autoComplete="off"
      />
      <SegmentedControl
        aria-label="Which way"
        fullWidth
        value={kind}
        onChange={(value) => {
          setKind(value as CategoryKind);
          setCategoryError(null);
        }}
        data={KIND_OPTIONS}
      />
      <NativeSelect
        label="Account"
        value={account?.id ?? ''}
        onChange={(e) => setAccountId(e.currentTarget.value)}
        data={listedAccounts.map((a) => ({ value: a.id, label: a.name }))}
      />
      <Input.Wrapper
        label="Category"
        labelElement="div"
        id="entry-category"
        error={categoryError}
      >
        <Chip.Group
          value={categoryId ?? null}
          onChange={(value) => {
            setPicked((before) => ({ ...before, [kind]: value }));
            setCategoryError(null);
          }}
        >
          <div
            className={classes.chips}
            role="radiogroup"
            aria-labelledby="entry-category-label"
          >
            {nodes.map((node) => (
              <Chip
                key={node.id}
                value={node.id}
                size="sm"
                type="radio"
              >
                {node.name}
              </Chip>
            ))}
          </div>
          {top != null && top.subcategories.length > 0 && (
            <div
              className={classes.subChips}
              role="radiogroup"
              aria-label={`In ${top.name}`}
            >
              {top.subcategories.map((sub) => (
                <Chip
                  key={sub.id}
                  value={sub.id}
                  size="sm"
                  type="radio"
                  variant="outline"
                >
                  {sub.name}
                </Chip>
              ))}
            </div>
          )}
        </Chip.Group>
        <Anchor
          href="?categories"
          size="sm"
          className={classes.editCategories}
          onClick={(e) => {
            e.preventDefault();
            // The page moves on first, so closing the sheet doesn't step back from it
            navigate('?categories');
            onDone();
          }}
        >
          Edit categories
        </Anchor>
      </Input.Wrapper>
      <TextInput
        type="date"
        label="Date"
        value={date}
        max={toDateInput(new Date())}
        min="2000-01-01"
        onChange={(e) => setDate(e.currentTarget.value)}
        error={dateError}
      />
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        className={classes.more}
        leftSection={more ? <CaretDown size={14} /> : <CaretRight size={14} />}
        aria-expanded={more}
        onClick={() => setMore((shown) => !shown)}
      >
        More
      </Button>
      {more && (
        <>
          <TextInput
            label={kind === 'income' ? 'From' : 'Paid to'}
            value={payee}
            onChange={(e) => setPayee(e.currentTarget.value)}
            maxLength={MAX_PAYEE}
            autoComplete="off"
          />
          <Textarea
            label="Note"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            maxLength={MAX_NOTE}
            autosize
            minRows={2}
          />
        </>
      )}
      <div className={classes.actions}>
        {editing != null && (
          <Button
            variant="subtle"
            color="red"
            leftSection={<Trash size={16} />}
            onClick={remove}
          >
            Delete
          </Button>
        )}
        <Button
          type="submit"
          className={classes.save}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
