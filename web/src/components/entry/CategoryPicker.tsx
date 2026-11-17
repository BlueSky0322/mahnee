import { BackIcon, ForwardIcon, PlusIcon } from '../ui/icons';
import type { KeyboardEvent } from 'react';
import { useEffect, useId, useState } from 'react';
import type { Category, PayeeCategory } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { MAX_CATEGORIES, MAX_CATEGORY_NAME, whyNotUnder } from '@shared/categories';
import { api } from '../../api';
import type { CategoryNode } from '../../ledger/category-tree';
import { categoryColour } from '../../utils/category-colour';
import Key from '../ui/Key';
import type { NamedCategory } from './add-text';
import { listedCategories, payeeHint } from './add-text';
import classes from './AddEntry.module.css';

// Picking the category for Add, or making a new one as it's typed (R-Add-Pick,
// R-Desk-Add-Pick): a search that finds the kind's listed categories by name, and, when
// what's typed isn't one, ways to make it: under the category the payee was last filed in
// ("Tealive was in Food"), as its own category, or under another one picked. With nothing
// typed it lists the recent ones, then the rest. On a phone it's a page of its own, with
// Entry to go back; on a computer it opens under the For row.

export interface NewCategory {
  id: string;
  name: string;
  parentId: string | null;
}

interface CategoryPickerProps {
  kind: CategoryKind;
  categories: readonly Category[];
  nodes: readonly CategoryNode[];
  recent: readonly NamedCategory[];
  /** The payee typed in Add, for the hint */
  payee: string;
  /** The account Add is on, whose payees come first */
  accountId: string | null;
  /** A page of its own (phones), with a header and Entry to go back */
  page: boolean;
  onPick: (id: string) => void;
  onCreate: (made: Omit<NewCategory, 'id'>) => void;
  onBack: () => void;
}

/** The payees and where they were last filed, read once the picker has a payee to look for */
function usePayees(accountId: string | null, payee: string) {
  const [payees, setPayees] = useState<PayeeCategory[]>([]);
  const wanted = accountId != null && payee.trim() !== '';
  useEffect(() => {
    if (!wanted || accountId == null) return;
    let current = true;
    // Only a hint: offline or failing, there is simply none
    api
      .getPayeeCategories(accountId)
      .then((answer) => current && setPayees(answer.payees))
      .catch(() => current && setPayees([]));
    return () => {
      current = false;
    };
  }, [accountId, wanted]);
  return wanted ? payees : [];
}

export default function CategoryPicker({
  kind,
  categories,
  nodes,
  recent,
  payee,
  accountId,
  page,
  onPick,
  onCreate,
  onBack,
}: CategoryPickerProps) {
  const [typed, setTyped] = useState('');
  const [choosingParent, setChoosingParent] = useState(false);
  const payees = usePayees(accountId, payee);
  const ids = { heading: useId(), recent: useId(), rest: useId(), create: useId() };
  const listed = listedCategories(nodes);
  const name = typed.trim();
  const lower = name.toLowerCase();
  const dot = (id: string) => (
    <span
      className={classes.dot}
      style={{ background: categoryColour(categories, id) }}
    />
  );
  const pickButton = (c: NamedCategory) => (
    <button
      key={c.id}
      type="button"
      className={classes.option}
      onClick={() => onPick(c.id)}
    >
      {dot(c.id)}
      <span className={classes.optionText}>{c.fullName}</span>
    </button>
  );

  const found = name === '' ? [] : listed.filter((c) => c.fullName.toLowerCase().includes(lower));
  const exact = listed.some((c) => c.name.toLowerCase() === lower);
  const archived = categories.find(
    (c) => c.kind === kind && c.archived && c.name.toLowerCase() === lower,
  );
  const full = categories.length >= MAX_CATEGORIES;
  const hint = payeeHint(payee, kind, payees, categories);
  const creating = name !== '' && !exact && archived == null && !full;
  const kindWord = kind === 'expense' ? 'expense' : 'income';

  // Enter takes the first choice, as the computer's list marks it
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (found.length > 0 && name !== '') onPick(found[0].id);
    else if (creating) onCreate({ name, parentId: hint?.parentId ?? null });
  };

  let body;
  if (choosingParent) {
    body = (
      <section
        aria-labelledby={ids.create}
        className={classes.pickSection}
      >
        <p
          id={ids.create}
          className={classes.pickLabel}
        >
          Put {name} under
        </p>
        <div className={classes.pickCard}>
          {nodes.map((node) => {
            const why = whyNotUnder(categories, { id: '', kind }, node.id);
            return (
              <button
                key={node.id}
                type="button"
                className={classes.option}
                aria-disabled={why != null}
                onClick={() => why == null && onCreate({ name, parentId: node.id })}
              >
                {dot(node.id)}
                <span className={classes.optionText}>
                  {node.name}
                  {why != null && <span className={classes.why}>{why}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  } else if (name === '') {
    const rest = listed.filter((c) => !recent.some((r) => r.id === c.id));
    body = (
      <>
        <section
          aria-labelledby={ids.recent}
          className={classes.pickSection}
        >
          <p
            id={ids.recent}
            className={classes.pickLabel}
          >
            Recent
          </p>
          <div className={classes.pickCard}>{recent.map(pickButton)}</div>
        </section>
        {rest.length > 0 && (
          <section
            aria-labelledby={ids.rest}
            className={classes.pickSection}
          >
            <p
              id={ids.rest}
              className={classes.pickLabel}
            >
              All categories
            </p>
            <div className={classes.pickCard}>{rest.map(pickButton)}</div>
          </section>
        )}
      </>
    );
  } else {
    body = (
      <>
        {archived != null && !exact && (
          <p className={classes.pickNote}>
            {archived.name} is archived. Bring it back in Categories to use it.
          </p>
        )}
        {full && !exact && archived == null && (
          <p className={classes.pickNote}>
            You can have up to {MAX_CATEGORIES} categories, archived ones included
          </p>
        )}
        {creating && (
          <section className={classes.pickSection}>
            <p
              id={ids.create}
              className={classes.pickLabel}
            >
              New category: {name}
            </p>
            <div
              className={classes.pickCard}
              role="listbox"
              aria-labelledby={page ? ids.create : undefined}
              aria-label={page ? undefined : `Create ${name}`}
            >
              {hint != null && (
                <button
                  type="button"
                  role="option"
                  aria-selected
                  className={`${classes.option} ${classes.optionOn}`}
                  onClick={() => onCreate({ name, parentId: hint.parentId })}
                >
                  <PlusIcon
                    size={16}
                    aria-hidden
                  />
                  <span className={classes.optionText}>
                    Under {hint.parentName}
                    <span className={classes.why}>{hint.text}</span>
                  </span>
                  {!page && <Key>Enter</Key>}
                </button>
              )}
              <button
                type="button"
                role="option"
                aria-selected={hint == null}
                className={classes.option}
                onClick={() => onCreate({ name, parentId: null })}
              >
                <PlusIcon
                  size={16}
                  aria-hidden
                />
                <span className={classes.optionText}>As its own {kindWord} category</span>
              </button>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={classes.option}
                onClick={() => setChoosingParent(true)}
              >
                <PlusIcon
                  size={16}
                  aria-hidden
                />
                <span className={classes.optionText}>Under another category</span>
                <ForwardIcon
                  size={14}
                  aria-hidden
                />
              </button>
            </div>
          </section>
        )}
        {found.length > 0 && <div className={classes.pickCard}>{found.map(pickButton)}</div>}
      </>
    );
  }

  return (
    <div className={page ? classes.pickPage : classes.pickInline}>
      {page && (
        <div className={classes.pickHeader}>
          <button
            type="button"
            className={classes.back}
            onClick={onBack}
          >
            <BackIcon
              size={18}
              aria-hidden
            />
            Entry
          </button>
          <h2 id={ids.heading}>Category</h2>
          <span className={classes.headerSpace} />
        </div>
      )}
      <input
        className={classes.search}
        type="search"
        aria-label="Find or create a category"
        value={typed}
        maxLength={MAX_CATEGORY_NAME}
        autoComplete="off"
        data-autofocus
        autoFocus
        onChange={(e) => {
          setTyped(e.currentTarget.value);
          setChoosingParent(false);
        }}
        onKeyDown={onKeyDown}
      />
      {body}
    </div>
  );
}
