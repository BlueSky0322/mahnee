import { useThisMonth } from '../../ledger/month-start';
import { useCurrency } from '../../profile/ProfileContext';
import { ActionIcon, Button } from '@mantine/core';
import { ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { CheckIcon, InIcon, OutIcon, PlusIcon } from '../ui/icons';
import { Fragment, useState } from 'react';
import type { Category, MonthBudget } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import {
  CATEGORY_KINDS,
  DEFAULT_CATEGORIES,
  MAX_CATEGORY_NAME,
  readCategoryName,
  siblingsOf,
  whyNotUnder,
} from '@shared/categories';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { change } from '../../ledger/ledger';
import type { CategoryNode } from '../../ledger/category-tree';
import { useCategories, useMonthSummary } from '../../ledger/useLedger';
import { categoryColour } from '../../utils/category-colour';
import { newId } from '../../utils/id';
import { formatMoney } from '../../utils/money';
import { showRefusal } from '../../utils/notify';
import { SettingsFooter } from '../common/Freshness';
import Key from '../ui/Key';
import Skeleton, { Loading } from '../ui/Skeleton';
import { SectionHeader } from '../settings/SettingsPage';
import CategoryForm, { type OpenCategory } from './CategoryForm';
import { KIND_LABELS } from './category-text';
import classes from './Categories.module.css';

/** Placeholder rows while the categories load */
const LOADING_ROWS = 6;

/** How many top-level categories of a kind Mahnee starts with */
const startsWith = (kind: CategoryKind) =>
  DEFAULT_CATEGORIES.filter((c) => c.kind === kind && c.parentId == null).length;

// Categories (?settings=categories; R-Categories, R-Desk-Categories): expenses and income,
// each top-level category with its colour, its budget and its subcategories as chips.
// A subcategory is added in place under its category (+), a top-level one from the field at
// the foot of its kind. Tap a name to rename it, move it, archive it or set its budget.
// Reorder shows arrows to put one higher or lower among the ones beside it; Archived lists
// the ones taken out, to bring back. Under the title, what Mahnee starts with. Reached from Set a budget (?settings=categories&budget),
// it asks for an expense category, and the first one opened has its Monthly budget ready
// to type.
export default function CategoriesPage() {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const { categories, tree, failed, retry } = useCategories();
  const [open, setOpen] = useState<OpenCategory | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [reordering, setReordering] = useState(false);
  const isDesktop = useIsDesktop();
  // This month's budgets, as shown: null until known
  const { summary } = useMonthSummary(month);
  const budgets = summary == null ? null : summary.budgets ?? [];
  // From Set a budget: asks for a category, until the first one opened closes
  const [forBudget, setForBudget] = useState(() =>
    new URLSearchParams(window.location.search).has('budget'),
  );

  /** Moves a category past the listed one before or after it */
  const step = (category: Category, listed: Category[], by: -1 | 1) => {
    const neighbour = listed[listed.findIndex((c) => c.id === category.id) + by];
    if (neighbour == null || categories == null) return;
    // Its place among every sibling, archived ones too, counted without it
    const siblings = siblingsOf(categories, category.kind, category.parentId);
    change({
      op: 'updateCategory',
      id: category.id,
      position: siblings.findIndex((c) => c.id === neighbour.id),
    });
    keepFocus(category.id, by);
  };

  /** Adds a category named `typed` (trimmed) of `kind`, under `parentId` or at the top */
  const add = (typed: string, kind: CategoryKind, parentId: string | null) => {
    const name = readCategoryName(typed);
    if (name == null || categories == null) return false;
    const id = newId();
    const reason = whyNotUnder(categories, { id, kind }, parentId);
    if (reason != null) {
      showRefusal(reason);
      return false;
    }
    change({ op: 'addCategory', category: { id, name, kind, parentId } });
    return true;
  };

  const archivedToggle =
    tree != null && tree.archived.length > 0 ? (
      <Button
        variant="subtle"
        size={isDesktop ? 'xs' : 'sm'}
        className={classes.archivedToggle}
        aria-expanded={showArchived}
        onClick={() => setShowArchived((shown) => !shown)}
      >
        Archived
      </Button>
    ) : null;

  return (
    <div className={classes.page}>
      <SectionHeader
        title="Categories"
        actions={
          <>
            {tree != null && (
              <Button
                variant="light"
                size="xs"
                aria-pressed={reordering}
                onClick={() => setReordering((on) => !on)}
              >
                {reordering ? 'Done' : 'Reorder'}
              </Button>
            )}
            {isDesktop && archivedToggle}
          </>
        }
      />

      <p className={classes.intro}>
        {`Comes with ${startsWith('expense')} expense and ${startsWith('income')} income categories. Edit them any time.`}
      </p>

      {forBudget && (
        <p className={classes.budgetPrompt}>Choose an expense category to set its monthly budget</p>
      )}

      {tree == null || categories == null ? (
        failed ? (
          <div className={classes.card}>
            <p className={classes.muted}>Couldn't load your categories.</p>
            <Button
              variant="default"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Loading
            label="Loading your categories"
            className={classes.list}
          >
            {Array.from({ length: LOADING_ROWS }, (_, i) => (
              <div
                key={i}
                className={classes.row}
              >
                <Skeleton
                  width={i % 2 === 0 ? 120 : 88}
                  height={16}
                />
              </div>
            ))}
          </Loading>
        )
      ) : (
        <>
          {CATEGORY_KINDS.map((kind) => (
            <Section
              key={kind}
              kind={kind}
              nodes={tree.listed[kind]}
              categories={categories}
              budgets={budgets}
              reordering={reordering}
              onOpen={(category) => setOpen({ kind, category })}
              onStep={step}
              onAdd={add}
            />
          ))}

          {!isDesktop && archivedToggle}
          {showArchived && tree.archived.length > 0 && (
            <section
              className={classes.section}
              aria-label="Archived categories"
            >
              <ul className={`${classes.list} ${classes.mutedList}`}>
                {tree.archived.map((category) => {
                  const detail = archivedDetail(category, categories);
                  return (
                    <li key={category.id}>
                      <button
                        type="button"
                        className={classes.archivedRow}
                        aria-label={`${category.name}, ${detail}`}
                        onClick={() => setOpen({ kind: category.kind, category })}
                      >
                        <span className={classes.name}>{category.name}</span>
                        <span className={classes.detail}>{detail}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      {!isDesktop && (
        <SettingsFooter
          month={month}
          onlyStale
        />
      )}
      <CategoryForm
        open={open}
        categories={categories ?? []}
        budgets={budgets}
        focusBudget={forBudget}
        onClose={() => {
          setOpen(null);
          setForBudget(false);
        }}
      />
    </div>
  );
}

interface SectionProps {
  kind: CategoryKind;
  nodes: CategoryNode[];
  /** Every category, archived ones too */
  categories: Category[];
  /** This month's budgets; null while not known */
  budgets: MonthBudget[] | null;
  reordering: boolean;
  onOpen: (category: Category) => void;
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
  /** Adds one, answering whether it was */
  onAdd: (typed: string, kind: CategoryKind, parentId: string | null) => boolean;
}

/** A kind's categories, and the field to add a top-level one */
function Section({
  kind,
  nodes,
  categories,
  budgets,
  reordering,
  onOpen,
  onStep,
  onAdd,
}: SectionProps) {
  const titleId = `categories-${kind}`;
  const isDesktop = useIsDesktop();
  const [adding, setAdding] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const newLabel = kind === 'expense' ? 'New expense category' : 'New income category';
  return (
    <section
      className={classes.section}
      aria-labelledby={titleId}
      // Settings' list of parts on a computer brings it into view with the keyboard on it
      tabIndex={-1}
    >
      <div className={classes.kindHead}>
        <span
          className={classes.kindIcon}
          data-kind={kind}
          aria-hidden
        >
          {kind === 'expense' ? (
            <OutIcon size={isDesktop ? 20 : 18} />
          ) : (
            <InIcon size={isDesktop ? 20 : 18} />
          )}
        </span>
        <h2
          id={titleId}
          className={classes.sectionTitle}
        >
          {KIND_LABELS[kind]}
        </h2>
      </div>
      <ul className={`${classes.list} ${kind === 'income' ? classes.income : ''}`}>
        {nodes.map((node) => (
          <li
            key={node.id}
            className={classes.category}
          >
            <Top
              node={node}
              colour={categoryColour(categories, node.id)}
              budget={budgets?.find((b) => b.categoryId === node.id)}
              listed={nodes}
              reordering={reordering}
              onOpen={onOpen}
              onStep={onStep}
              onAddUnder={
                node.subcategories.length === 0 && adding !== node.id
                  ? () => setAdding(node.id)
                  : null
              }
            />
            {(node.subcategories.length > 0 || adding === node.id) && (
              <Subcategories
                node={node}
                reordering={reordering}
                adding={adding === node.id}
                onAdding={(on) => setAdding(on ? node.id : null)}
                onOpen={onOpen}
                onStep={onStep}
                onAdd={(name) => onAdd(name, kind, node.id)}
              />
            )}
          </li>
        ))}
        <li>
          <label className={classes.newRow}>
            <PlusIcon
              size={16}
              className={classes.newPlus}
            />
            <input
              className={classes.newField}
              aria-label={newLabel}
              placeholder={newLabel}
              maxLength={MAX_CATEGORY_NAME}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (onAdd(typed, kind, null)) setTyped('');
              }}
            />
          </label>
        </li>
      </ul>
    </section>
  );
}

/** A whole number of ringgit without cents ("RM 800"), else as it is ("RM 120.50") */
const budgetMoney = (cents: number, currency: string) => {
  const text = formatMoney(cents, currency);
  return cents % 100 === 0 ? text.replace(/\.00$/, '') : text;
};

/** A top-level category's row: its colour, name, budget, arrows when reordering, and + */
function Top({
  node,
  colour,
  budget,
  listed,
  reordering,
  onOpen,
  onStep,
  onAddUnder,
}: {
  node: CategoryNode;
  colour: string;
  budget?: MonthBudget;
  listed: Category[];
  reordering: boolean;
  onOpen: (category: Category) => void;
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
  /** Opens the field for its first subcategory; null once it has some (the + is after them) */
  onAddUnder: (() => void) | null;
}) {
  const homeCurrency = useCurrency();
  return (
    <div className={classes.top}>
      <span
        className={classes.dot}
        style={{ background: colour }}
        aria-hidden
      />
      <button
        type="button"
        className={classes.nameButton}
        onClick={() => onOpen(node)}
      >
        {node.name}
      </button>
      {budget?.amountCents != null && (
        <span className={classes.budget}>
          {budgetMoney(budget.amountCents, homeCurrency)} a month
        </span>
      )}
      {reordering ? (
        <Arrows
          category={node}
          listed={listed}
          onStep={onStep}
        />
      ) : (
        onAddUnder != null && (
          <AddButton
            parent={node.name}
            onClick={onAddUnder}
          />
        )
      )}
    </div>
  );
}

/** A category's subcategories as chips, and the field to add one when it's open */
function Subcategories({
  node,
  reordering,
  adding,
  onAdding,
  onOpen,
  onStep,
  onAdd,
}: {
  node: CategoryNode;
  reordering: boolean;
  adding: boolean;
  onAdding: (on: boolean) => void;
  onOpen: (category: Category) => void;
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
  onAdd: (name: string) => boolean;
}) {
  const isDesktop = useIsDesktop();
  const [typed, setTyped] = useState('');
  const name = typed.trim();
  const save = () => {
    if (name === '') return;
    if (onAdd(name)) {
      setTyped('');
      onAdding(false);
    }
  };
  return (
    <>
      <div
        className={classes.chips}
        role="list"
        aria-label={`Under ${node.name}`}
      >
        {node.subcategories.map((sub) => (
          <Fragment key={sub.id}>
            <span
              role="listitem"
              className={classes.chipItem}
            >
              <button
                type="button"
                className={classes.chip}
                onClick={() => onOpen(sub)}
              >
                {sub.name}
              </button>
              {reordering && (
                <Arrows
                  category={sub}
                  listed={node.subcategories}
                  onStep={onStep}
                />
              )}
            </span>
          </Fragment>
        ))}
        {adding ? (
          <label
            role="listitem"
            className={classes.inline}
          >
            <input
              className={classes.inlineField}
              aria-label={`New under ${node.name}`}
              placeholder={`New under ${node.name}`}
              maxLength={MAX_CATEGORY_NAME}
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
              }}
              onBlur={() => {
                if (name === '') onAdding(false);
              }}
            />
            {name !== '' && (
              <button
                type="button"
                className={classes.inlineAdd}
                aria-label={`Add ${name} under ${node.name}`}
                // Kept from taking the keyboard, so the field doesn't close first
                onMouseDown={(e) => e.preventDefault()}
                onClick={save}
              >
                <CheckIcon size={14} />
              </button>
            )}
          </label>
        ) : (
          !reordering &&
          node.subcategories.length > 0 && (
            <span role="listitem">
              <AddButton
                parent={node.name}
                onClick={() => onAdding(true)}
              />
            </span>
          )
        )}
      </div>
      {adding && node.kind === 'expense' && (
        <p className={classes.hint}>
          {isDesktop ? (
            <>
              <Key>Enter</Key> <span>counts toward {node.name}'s budget</span>
            </>
          ) : (
            <span>Counts toward {node.name}'s budget</span>
          )}
        </p>
      )}
    </>
  );
}

/** + : a new subcategory under `parent`, a dashed ring */
function AddButton({ parent, onClick }: { parent: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={classes.addButton}
      aria-label={`Add a subcategory under ${parent}`}
      onClick={onClick}
    >
      <PlusIcon size={14} />
    </button>
  );
}

/** Up and down, among the listed ones beside it */
function Arrows({
  category,
  listed,
  onStep,
}: {
  category: Category;
  listed: Category[];
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
}) {
  const at = listed.findIndex((c) => c.id === category.id);
  return (
    <span className={classes.arrows}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label={`Move ${category.name} up`}
        data-step={`${category.id}:-1`}
        disabled={at <= 0}
        onClick={() => onStep(category, listed, -1)}
      >
        <ArrowUp size={18} />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="lg"
        aria-label={`Move ${category.name} down`}
        data-step={`${category.id}:1`}
        disabled={at >= listed.length - 1}
        onClick={() => onStep(category, listed, 1)}
      >
        <ArrowDown size={18} />
      </ActionIcon>
    </span>
  );
}

/** What an archived category was: its list, or what it was in, and what comes back with it */
function archivedDetail(category: Category, categories: Category[]) {
  const parent = categories.find((c) => c.id === category.parentId);
  if (parent != null) return `in ${parent.name}`;
  const subs = categories.filter((c) => c.parentId === category.id && !c.archived).length;
  const kind = KIND_LABELS[category.kind];
  if (subs === 0) return kind;
  return `${kind}, with ${subs} ${subs === 1 ? 'subcategory' : 'subcategories'}`;
}

/**
 * Keeps the keyboard on the arrow just pressed once its row has moved, or on the other
 * one when it's reached the end
 */
function keepFocus(id: string, by: -1 | 1) {
  requestAnimationFrame(() => {
    const pressed = document.querySelector<HTMLButtonElement>(`[data-step="${id}:${by}"]`);
    const other = document.querySelector<HTMLButtonElement>(`[data-step="${id}:${-by}"]`);
    (pressed?.disabled ? other : pressed)?.focus();
  });
}
