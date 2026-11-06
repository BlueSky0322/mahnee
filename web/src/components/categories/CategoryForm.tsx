import { Button, NativeSelect, Switch, TextInput } from '@mantine/core';
import { Archive, ArrowCounterClockwise } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { useId, useState } from 'react';
import type { Category, LedgerChange, MonthBudget } from '@shared/api';
import { whyNoBudget } from '@shared/budgets';
import type { CategoryKind } from '@shared/categories';
import {
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  readCategoryName,
  siblingsOf,
  whyNotUnder,
  whyStaysOnTop,
} from '@shared/categories';
import { change } from '../../ledger/ledger';
import { thisMonth } from '../../utils/date-input';
import { newId } from '../../utils/id';
import { showRefusal } from '../../utils/notify';
import { showUndo } from '../common/undo-toast';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { KIND_LABELS, budgetText, readBudget } from './category-text';
import classes from './Categories.module.css';

/** What's open: a new category of a kind, or one to change */
export interface OpenCategory {
  kind: CategoryKind;
  category: Category | null;
}

interface CategoryFormProps {
  open: OpenCategory | null;
  /** Every category, archived ones too */
  categories: Category[];
  /** This month's budgets, as shown; null while not known */
  budgets: MonthBudget[] | null;
  onClose: () => void;
}

/** The "Under" choice for the top level */
const TOP_LEVEL = '';

/** Adding a category, or renaming one, moving it under another and archiving it */
export default function CategoryForm({ open, categories, budgets, onClose }: CategoryFormProps) {
  return (
    <ResponsiveDialog
      opened={open != null}
      onClose={onClose}
      title={
        open?.category == null
          ? `Add ${KIND_LABELS[open?.kind ?? 'expense'].toLowerCase()} category`
          : 'Edit category'
      }
      width={420}
    >
      {open != null && (
        <Fields
          // A fresh form for each category opened
          key={open.category?.id ?? `new-${open.kind}`}
          kind={open.kind}
          category={open.category}
          categories={categories}
          budget={
            open.category == null
              ? null
              : budgets?.find((b) => b.categoryId === open.category?.id) ??
                (budgets == null ? undefined : null)
          }
          onDone={onClose}
        />
      )}
    </ResponsiveDialog>
  );
}

function Fields({
  kind,
  category,
  categories,
  budget,
  onDone,
}: {
  kind: CategoryKind;
  category: Category | null;
  categories: Category[];
  /** Its budget this month: null when it has none, undefined while that isn't known */
  budget: MonthBudget | null | undefined;
  onDone: () => void;
}) {
  // A new one's id is made now, so the rule can be asked about it
  const [id] = useState(() => category?.id ?? newId());
  const [name, setName] = useState(category?.name ?? '');
  const [under, setUnder] = useState(category?.parentId ?? TOP_LEVEL);
  const [nameError, setNameError] = useState<string | null>(null);
  // What's typed for the budget, and the switch; null until changed, showing what it is
  const [budgetTyped, setBudgetTyped] = useState<string | null>(null);
  const [carryTyped, setCarryTyped] = useState<boolean | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const carryHintId = useId();
  const budgetShown = budgetTyped ?? (budget == null ? '' : budgetText(budget.amountCents));
  const carryShown = carryTyped ?? budget?.carryOver ?? false;

  // What it can go under: the listed top-level categories of its kind, other than itself.
  // One it can't is shown, but can't be picked, and says why.
  const self = { id, kind };
  const staysOnTop = category == null ? null : whyStaysOnTop(categories, category);
  const parents = siblingsOf(categories, kind, null).filter((c) => !c.archived && c.id !== id);
  const options = [
    { value: TOP_LEVEL, label: 'Top level' },
    ...parents.map((p) => {
      // Staying on top, the choice is off as a whole, and says why
      const reason = staysOnTop == null ? whyNotUnder(categories, self, p.id) : null;
      return {
        value: p.id,
        label: reason == null ? p.name : `${p.name} (full)`,
        disabled: reason != null,
      };
    }),
  ];

  // A listed top-level spending category can have a budget; its subcategories count toward it
  const parentId = under === TOP_LEVEL ? null : under;
  const takesBudget =
    category != null && !category.archived && whyNoBudget({ kind, parentId }) == null;

  /** The budget change the form asks for, none when it leaves it as it is, or why it can't */
  const budgetChange = (): LedgerChange | null | { error: string } => {
    if (!takesBudget || category == null) return null;
    if (budgetTyped == null && carryTyped == null) return null;
    const read = readBudget(budgetShown);
    if ('error' in read) return read;
    const carryOver = read.cents != null && carryShown;
    if (
      read.cents === (budget?.amountCents ?? null) &&
      carryOver === (budget?.carryOver ?? false)
    ) {
      return null;
    }
    return {
      op: 'setBudget',
      categoryId: category.id,
      fromMonth: thisMonth(),
      amountCents: read.cents,
      carryOver,
    };
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checkedName = readCategoryName(name);
    setNameError(checkedName == null ? 'Give it a name' : null);
    const setBudget = budgetChange();
    const budgetWrong = setBudget != null && 'error' in setBudget ? setBudget.error : null;
    setBudgetError(budgetWrong);
    if (checkedName == null || budgetWrong != null) return;
    const budgetSet = setBudget as LedgerChange | null;

    if (category == null) {
      if (categories.length >= MAX_CATEGORIES) {
        showRefusal(`You can have up to ${MAX_CATEGORIES} categories, archived ones included`);
        return;
      }
      const reason = whyNotUnder(categories, self, parentId);
      if (reason != null) {
        showRefusal(reason);
        return;
      }
      change({ op: 'addCategory', category: { id, name: checkedName, kind, parentId } });
    } else {
      // Only what changed is sent
      const update: Extract<LedgerChange, { op: 'updateCategory' }> = {
        op: 'updateCategory',
        id: category.id,
      };
      if (checkedName !== category.name) update.name = checkedName;
      if (!category.archived && parentId !== category.parentId) {
        const reason = whyNotUnder(categories, category, parentId);
        if (reason != null) {
          showRefusal(reason);
          return;
        }
        update.parentId = parentId;
      }
      const changes: LedgerChange[] = [];
      if (update.name != null || update.parentId !== undefined) changes.push(update);
      if (budgetSet != null) changes.push(budgetSet);
      if (changes.length > 0) change(...changes);
    }
    onDone();
  };

  const archive = (archived: boolean) => {
    if (category == null) return;
    change({ op: 'archiveCategory', id: category.id, archived });
    onDone();
    if (archived) {
      showUndo(`Archived ${category.name}`, () =>
        change({ op: 'archiveCategory', id: category.id, archived: false }),
      );
    }
  };

  return (
    <form
      className={classes.form}
      onSubmit={submit}
      noValidate
    >
      <TextInput
        label="Name"
        placeholder={kind === 'expense' ? 'Coffee' : 'Bonus'}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={nameError}
        maxLength={MAX_CATEGORY_NAME}
        data-autofocus={category == null || undefined}
        autoComplete="off"
      />
      {!category?.archived && (
        <NativeSelect
          label="Under"
          description={staysOnTop ?? 'Top level, or a subcategory of another'}
          value={under}
          onChange={(e) => setUnder(e.currentTarget.value)}
          disabled={staysOnTop != null}
          data={options}
        />
      )}
      {takesBudget && (
        <>
          <TextInput
            label="Monthly budget"
            description="The same every month from this one, until changed. Empty for none."
            placeholder="300"
            inputMode="decimal"
            value={budgetShown}
            onChange={(e) => setBudgetTyped(e.currentTarget.value)}
            error={budgetError}
            autoComplete="off"
          />
          <Switch
            label="Carry over"
            checked={carryShown}
            onChange={(e) => setCarryTyped(e.currentTarget.checked)}
            aria-describedby={carryHintId}
          />
          <p
            id={carryHintId}
            className={classes.hint}
          >
            Adds what's left at the end of a month to the next, or takes away what was overspent.
          </p>
        </>
      )}
      <div className={classes.actions}>
        {category != null &&
          (category.archived ? (
            <Button
              variant="subtle"
              color="gray"
              leftSection={<ArrowCounterClockwise size={16} />}
              onClick={() => archive(false)}
            >
              Bring back
            </Button>
          ) : (
            <Button
              variant="subtle"
              color="gray"
              leftSection={<Archive size={16} />}
              onClick={() => archive(true)}
            >
              Archive
            </Button>
          ))}
        <Button
          type="submit"
          className={classes.save}
        >
          {category == null ? 'Add category' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
