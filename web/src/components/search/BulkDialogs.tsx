import { Button, NativeSelect } from '@mantine/core';
import { useState } from 'react';
import type { Category, Transaction } from '@shared/api';
import { categoryKindFor } from '@shared/ledger';
import { categoryTree } from '../../ledger/category-tree';
import { categoryName } from '../common/category-name';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { categoryOptions, transactionsText } from './search-text';
import classes from './SearchPage.module.css';

/** What's done to the transactions ticked on Search */
export type BulkAction = 'move' | 'delete';

// The preview before changing many transactions at once: it says exactly what will
// change ("Move 80 transactions from Other to Food", "Delete 12 transactions"), and
// nothing changes until it's confirmed
export default function BulkDialogs({
  action,
  chosen,
  categories,
  onMove,
  onDelete,
  onClose,
}: {
  action: BulkAction | null;
  chosen: Transaction[];
  categories: Category[];
  onMove: (categoryId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  // What was opened stays drawn as the dialog closes, rather than emptying as it fades;
  // each opening is a fresh preview
  const [shown, setShown] = useState({ action, chosen, open: action != null, opening: 0 });
  if (action != null && (!shown.open || shown.action !== action || shown.chosen !== chosen)) {
    const same = shown.open && shown.action === action;
    setShown({ action, chosen, open: true, opening: same ? shown.opening : shown.opening + 1 });
  } else if (action == null && shown.open) {
    setShown({ ...shown, open: false });
  }
  // One dialog for both, so one opened as the other closes is never a second dialog
  return (
    <ResponsiveDialog
      opened={action != null}
      onClose={onClose}
      title={shown.action === 'delete' ? 'Delete transactions' : 'Change category'}
    >
      {shown.action === 'move' && (
        <MovePreview
          key={shown.opening}
          chosen={shown.chosen}
          categories={categories}
          onMove={onMove}
          onCancel={onClose}
        />
      )}
      {shown.action === 'delete' && (
        <div className={classes.preview}>
          <p className={classes.previewText}>Delete {transactionsText(shown.chosen.length)}</p>
          <p className={classes.muted}>Undo brings them back, for a few seconds after.</p>
          <div className={classes.previewActions}>
            <Button
              variant="default"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={onDelete}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </ResponsiveDialog>
  );
}

function MovePreview({
  chosen,
  categories,
  onMove,
  onCancel,
}: {
  chosen: Transaction[];
  categories: Category[];
  onMove: (categoryId: string) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState('');
  // Spending or income alone (Search refuses a mix, and transfers): its categories
  const kind = chosen.length === 0 ? null : categoryKindFor(chosen[0].kind);
  const options = kind == null ? [] : categoryOptions(categoryTree(categories).listed[kind]);
  const from = [...new Set(chosen.map((t) => t.categoryId))];
  const fromText =
    from.length === 1 ? categoryName(categories, from[0]) : `${from.length} categories`;
  return (
    <form
      className={classes.preview}
      onSubmit={(e) => {
        e.preventDefault();
        if (to !== '') onMove(to);
      }}
    >
      <NativeSelect
        label="Category"
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
        data={[{ value: '', label: 'Pick a category', disabled: true }, ...options]}
      />
      <p
        className={classes.previewText}
        aria-live="polite"
      >
        {to === ''
          ? `Pick where ${transactionsText(chosen.length)} go`
          : `Move ${transactionsText(chosen.length)} from ${fromText} to ${categoryName(categories, to)}`}
      </p>
      <div className={classes.previewActions}>
        <Button
          variant="default"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={to === ''}
        >
          Move
        </Button>
      </div>
    </form>
  );
}
