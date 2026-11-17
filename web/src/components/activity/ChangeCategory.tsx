import { Button, TextInput } from '@mantine/core';
import { MagnifyingGlass } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { Category, LedgerChange, Transaction } from '@shared/api';
import { DEFAULT_CURRENCY, categoryKindFor } from '@shared/ledger';
import { foldCase } from '@shared/search';
import { budgetLines } from '../../ledger/budgets';
import { change } from '../../ledger/ledger';
import { useMonths } from '../../ledger/month-start';
import { useAccounts, useCategories, useMonthSummary } from '../../ledger/useLedger';
import { useIsMobile } from '../../hooks/useBreakpoints';
import { toDateInput } from '../../utils/date-input';
import { categoryColour } from '../../utils/category-colour';
import { formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';
import { showUndo } from '../common/undo-toast';
import Key from '../ui/Key';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import {
  budgetEffect,
  entriesText,
  listAmount,
  movingLine,
  nowIn,
  rowText,
  shortDay,
} from './activity-text';
import classes from './Activity.module.css';

/** The most entries a computer's dialog lists by name before saying how many more */
const LISTED = 5;

// Change category for the entries ticked (R-Activity-Move, R-Desk-Bulk): which they are and
// where they are now, a list of the kind's categories to move them to (each top-level one
// with its subcategories, searchable), and what moving them does: how much from where to
// where, and what it does to that category's budget this month (the budget month Home
// shows). Only the entries dated this month move the budget, and none already in that
// budget. One change through the ledger, with Undo putting each back where it came from.
export default function ChangeCategory({
  chosen,
  onClose,
  onMoved,
}: {
  /** The entries to move, all spending or all income; null while it's closed */
  chosen: Transaction[] | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const isMobile = useIsMobile();
  // What was opened stays drawn as the dialog closes, rather than emptying as it fades
  const [shown, setShown] = useState<{ chosen: Transaction[]; opening: number }>({
    chosen: [],
    opening: 0,
  });
  if (chosen != null && chosen !== shown.chosen) {
    setShown({ chosen, opening: shown.opening + 1 });
  }
  const n = shown.chosen.length;
  return (
    <ResponsiveDialog
      opened={chosen != null}
      onClose={onClose}
      title={`Change the category of ${isMobile ? n : entriesText(n)}`}
      width={720}
    >
      {n > 0 && (
        <Moving
          key={shown.opening}
          chosen={shown.chosen}
          wide={!isMobile}
          onCancel={onClose}
          onMoved={onMoved}
        />
      )}
    </ResponsiveDialog>
  );
}

function Moving({
  chosen,
  wide,
  onCancel,
  onMoved,
}: {
  chosen: Transaction[];
  wide: boolean;
  onCancel: () => void;
  onMoved: () => void;
}) {
  const { accounts } = useAccounts();
  const { categories, tree } = useCategories();
  // This month, the person's (shared/period.ts)
  const { current } = useMonths();
  const { summary } = useMonthSummary(current.month);
  const [find, setFind] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const all = categories ?? [];
  const kind = categoryKindFor(chosen[0].kind) ?? 'expense';
  const name = (id: string | null) => categoryName(all, id);
  const today = toDateInput(new Date());
  const currency = DEFAULT_CURRENCY;

  const words = foldCase(find.trim());
  const has = (c: Category) => words === '' || foldCase(c.name).includes(words);
  const nodes = (tree?.listed[kind] ?? [])
    .map((node) => ({
      node,
      subs: has(node) ? node.subcategories : node.subcategories.filter(has),
    }))
    .filter(({ node, subs }) => has(node) || subs.length > 0);

  const target = all.find((c) => c.id === to) ?? null;
  const top =
    target == null ? null : all.find((c) => c.id === (target.parentId ?? target.id)) ?? null;
  // At most MAX_BULK_TRANSACTIONS of at most MAX_TRANSACTION_CENTS: exact
  const sum = chosen.reduce((total, t) => total + t.amountCents, 0);
  const topOf = (id: string | null) => {
    const c = all.find((x) => x.id === id);
    return c?.parentId ?? c?.id ?? null;
  };
  // What newly lands in the target's budget this month
  const intoBudget = chosen
    .filter(
      (t) =>
        t.date >= current.firstDay && t.date <= current.lastDay && topOf(t.categoryId) !== top?.id,
    )
    .reduce((total, t) => total + t.amountCents, 0);
  // This month's budget on it, if it has one
  const line =
    top == null || summary == null
      ? undefined
      : budgetLines(summary, all).find((b) => b.id === top.id);
  const short = target?.name ?? '';
  const payee = chosen.every((t) => t.payee != null && t.payee === chosen[0].payee)
    ? chosen[0].payee
    : null;

  const move = () => {
    if (to == null) return;
    const ids = chosen.map((t) => t.id);
    // Undo puts each back in the category it came from: one change per category
    const from = new Map<string, string[]>();
    for (const t of chosen) {
      if (t.categoryId == null || t.categoryId === to) continue;
      from.set(t.categoryId, [...(from.get(t.categoryId) ?? []), t.id]);
    }
    change({ op: 'recategoriseTransactions', ids, categoryId: to });
    onMoved();
    showUndo(`Moved ${ids.length} to ${short}`, () =>
      change(
        ...[...from].map(
          ([back, those]): LedgerChange => ({
            op: 'recategoriseTransactions',
            ids: those,
            categoryId: back,
          }),
        ),
      ),
    );
  };

  const option = (c: Category, sub: boolean) => (
    <button
      key={c.id}
      type="button"
      role="radio"
      aria-checked={to === c.id}
      className={sub ? classes.subOption : classes.option}
      onClick={() => setTo(c.id)}
    >
      {!sub && (
        <span
          className={classes.dot}
          aria-hidden
          style={{ '--dot': categoryColour(all, c.id) } as CSSProperties}
        />
      )}
      {c.name}
    </button>
  );

  return (
    <div className={classes.moving}>
      {wide ? (
        <>
          <p className={classes.soft}>
            {payee != null
              ? `All ${payee}, now in ${nowIn(chosen, name)}`
              : `Now in ${nowIn(chosen, name)}`}
          </p>
          <div className={classes.movingList}>
            {chosen.slice(0, LISTED).map((t) => (
              <div
                key={t.id}
                className={classes.movingRow}
              >
                <span className={classes.muted}>{shortDay(t.date, today)}</span>
                <span>
                  {[
                    rowText(t, {
                      accounts: accounts ?? [],
                      categories: all,
                      q: '',
                      selecting: false,
                      today,
                    }).title,
                    accounts?.find((a) => a.id === t.accountId)?.name,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="sf-tabular">{listAmount(t, currency)}</span>
              </div>
            ))}
            {chosen.length > LISTED && (
              <span className={classes.muted}>and {chosen.length - LISTED} more</span>
            )}
          </div>
          <h3 className={classes.movingHeading}>Move them to</h3>
        </>
      ) : (
        <p className={classes.soft}>{movingLine(chosen, name, today)}</p>
      )}
      <TextInput
        type="search"
        aria-label="Find a category"
        placeholder={`Find an ${kind === 'income' ? 'income' : 'expense'} category`}
        leftSection={<MagnifyingGlass size={16} />}
        value={find}
        onChange={(e) => setFind(e.currentTarget.value)}
      />
      <div
        role="radiogroup"
        aria-label="Move to"
        className={classes.options}
      >
        {nodes.map(({ node, subs }) => (
          <div
            key={node.id}
            className={classes.optionRow}
            data-on={top?.id === node.id || undefined}
          >
            {option(node, false)}
            {subs.map((c) => option(c, true))}
          </div>
        ))}
      </div>
      <div className={classes.movingFoot}>
        {target != null && (
          <p className={classes.summary}>
            <span>
              <span className="sf-tabular">{formatMoney(sum, currency)}</span> from{' '}
              {nowIn(chosen, name)} to {name(target.id)}
            </span>
            {kind === 'expense' && top != null && summary != null && (
              <span className={classes.muted}>
                {budgetEffect(top.name, line ?? null, intoBudget, currency)}
              </span>
            )}
          </p>
        )}
        <div className={classes.movingActions}>
          <Button
            variant="subtle"
            color="gray"
            onClick={onCancel}
            rightSection={wide ? <Key>Esc</Key> : undefined}
          >
            Cancel
          </Button>
          <Button
            disabled={target == null}
            onClick={move}
          >
            {target == null ? `Move ${chosen.length}` : `Move ${chosen.length} to ${short}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
