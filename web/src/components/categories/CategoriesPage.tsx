import { ActionIcon, Button } from '@mantine/core';
import {
  ArrowDown,
  ArrowElbowDownRight,
  ArrowUp,
  CaretDown,
  CaretLeft,
  CaretRight,
  Plus,
} from '@phosphor-icons/react';
import { useState } from 'react';
import type { Category } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { CATEGORY_KINDS, siblingsOf } from '@shared/categories';
import { goUp } from '../../hooks/useRoute';
import { change } from '../../ledger/ledger';
import type { CategoryNode } from '../../ledger/category-tree';
import { useCategories } from '../../ledger/useLedger';
import Skeleton, { Loading } from '../ui/Skeleton';
import CategoryForm, { type OpenCategory } from './CategoryForm';
import { KIND_LABELS } from './category-text';
import classes from './Categories.module.css';

/** Placeholder rows while the categories load */
const LOADING_ROWS = 6;

// The categories page: spending and income, each top-level category with its
// subcategories under it. Tap one to rename, move or archive it; the arrows put it
// higher or lower among the ones beside it.
export default function CategoriesPage() {
  const { categories, tree, failed, retry } = useCategories();
  const [open, setOpen] = useState<OpenCategory | null>(null);
  const [showArchived, setShowArchived] = useState(false);

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

  return (
    <div className={classes.page}>
      <header className={classes.header}>
        <Button
          variant="subtle"
          color="gray"
          size="compact-md"
          className={classes.back}
          leftSection={<CaretLeft size={16} />}
          onClick={() => goUp('')}
        >
          Home
        </Button>
        <h1 className={classes.title}>Categories</h1>
      </header>

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
                <span className={classes.rowMain}>
                  <Skeleton
                    width={i % 2 === 0 ? 120 : 88}
                    height={16}
                  />
                </span>
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
              onAdd={() => setOpen({ kind, category: null })}
              onOpen={(category) => setOpen({ kind, category })}
              onStep={step}
            />
          ))}

          {tree.archived.length > 0 && (
            <section
              className={classes.section}
              aria-label="Archived categories"
            >
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                className={classes.archivedToggle}
                leftSection={showArchived ? <CaretDown size={14} /> : <CaretRight size={14} />}
                aria-expanded={showArchived}
                onClick={() => setShowArchived((shown) => !shown)}
              >
                Archived ({tree.archived.length})
              </Button>
              {showArchived && (
                <ul className={`${classes.list} ${classes.mutedList}`}>
                  {tree.archived.map((category) => {
                    const detail = archivedDetail(category, categories);
                    return (
                      <li key={category.id}>
                        <div className={classes.row}>
                          <button
                            type="button"
                            className={classes.rowMain}
                            aria-label={`${category.name}, ${detail}`}
                            onClick={() => setOpen({ kind: category.kind, category })}
                          >
                            <span className={classes.name}>{category.name}</span>
                            <span className={classes.detail}>{detail}</span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <CategoryForm
        open={open}
        categories={categories ?? []}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

function Section({
  kind,
  nodes,
  onAdd,
  onOpen,
  onStep,
}: {
  kind: CategoryKind;
  nodes: CategoryNode[];
  onAdd: () => void;
  onOpen: (category: Category) => void;
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
}) {
  const titleId = `categories-${kind}`;
  return (
    <section
      className={classes.section}
      aria-labelledby={titleId}
    >
      <div className={classes.sectionHeader}>
        <h2
          id={titleId}
          className={classes.sectionTitle}
        >
          {KIND_LABELS[kind]}
        </h2>
        <Button
          variant="subtle"
          size="compact-md"
          leftSection={<Plus size={16} />}
          aria-label={`Add ${KIND_LABELS[kind].toLowerCase()} category`}
          onClick={onAdd}
        >
          Add
        </Button>
      </div>
      {nodes.length === 0 ? (
        <div className={classes.card}>
          <p className={classes.muted}>No {KIND_LABELS[kind].toLowerCase()} categories listed.</p>
        </div>
      ) : (
        <ul
          className={classes.list}
          aria-labelledby={titleId}
        >
          {nodes.map((node) => (
            <li key={node.id}>
              <Row
                category={node}
                label={node.name}
                listed={nodes}
                onOpen={onOpen}
                onStep={onStep}
              />
              {node.subcategories.length > 0 && (
                <ul
                  className={classes.subList}
                  aria-label={`In ${node.name}`}
                >
                  {node.subcategories.map((sub) => (
                    <li key={sub.id}>
                      <Row
                        category={sub}
                        label={`${sub.name}, in ${node.name}`}
                        listed={node.subcategories}
                        onOpen={onOpen}
                        onStep={onStep}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  category,
  label,
  listed,
  onOpen,
  onStep,
}: {
  category: Category;
  /** What it's read out as */
  label: string;
  /** The listed categories beside it, it among them, in order */
  listed: Category[];
  onOpen: (category: Category) => void;
  onStep: (category: Category, listed: Category[], by: -1 | 1) => void;
}) {
  const at = listed.findIndex((c) => c.id === category.id);
  const sub = category.parentId != null;
  return (
    <div className={sub ? `${classes.row} ${classes.sub}` : classes.row}>
      {sub && (
        <ArrowElbowDownRight
          size={16}
          className={classes.subMark}
          aria-hidden
        />
      )}
      <button
        type="button"
        className={classes.rowMain}
        aria-label={label}
        onClick={() => onOpen(category)}
      >
        <span className={classes.name}>{category.name}</span>
      </button>
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
    </div>
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
