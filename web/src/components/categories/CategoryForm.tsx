import { Button, NativeSelect, TextInput } from '@mantine/core';
import { Archive, ArrowCounterClockwise } from '@phosphor-icons/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { Category, LedgerChange } from '@shared/api';
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
import { newId } from '../../utils/id';
import { showRefusal } from '../../utils/notify';
import { showUndo } from '../common/undo-toast';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { KIND_LABELS } from './category-text';
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
  onClose: () => void;
}

/** The "Under" choice for the top level */
const TOP_LEVEL = '';

/** Adding a category, or renaming one, moving it under another and archiving it */
export default function CategoryForm({ open, categories, onClose }: CategoryFormProps) {
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
  onDone,
}: {
  kind: CategoryKind;
  category: Category | null;
  categories: Category[];
  onDone: () => void;
}) {
  // A new one's id is made now, so the rule can be asked about it
  const [id] = useState(() => category?.id ?? newId());
  const [name, setName] = useState(category?.name ?? '');
  const [under, setUnder] = useState(category?.parentId ?? TOP_LEVEL);
  const [nameError, setNameError] = useState<string | null>(null);

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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checkedName = readCategoryName(name);
    setNameError(checkedName == null ? 'Give it a name' : null);
    if (checkedName == null) return;
    const parentId = under === TOP_LEVEL ? null : under;

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
      if (update.name != null || update.parentId !== undefined) change(update);
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
