import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';

// A colour for each category, so spending is easier to tell apart at a glance; its name is
// always shown too. Nothing is stored. Each top-level spending category wears one of six
// colours (--c1 to --c6 in theme/tokens.css): the ones a person starts with have the
// design's own, and one they add takes a colour from its id, so no category's colour moves
// when others are added, moved, renamed or archived. A subcategory wears its parent's.
// "Other", where unsorted spending goes, stays a quiet grey; income is green.

/** The six colours */
const COLOURS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

/** The starting spending categories' colours, by name as the design draws them (R-Categories) */
const STARTING: Record<string, string> = {
  Groceries: 'var(--c1)',
  Shopping: 'var(--c2)',
  Food: 'var(--c3)',
  Bills: 'var(--c4)',
  Health: 'var(--c4)',
  Transport: 'var(--c5)',
  Fun: 'var(--c6)',
};

/** The same, by the starting categories' fixed ids, so renaming one keeps its colour */
const BY_ID = new Map(
  DEFAULT_CATEGORIES.filter((c) => STARTING[c.name] != null).map((c) => [c.id, STARTING[c.name]]),
);

const GREY = 'var(--line-2)';
const INCOME = 'var(--pos)';

type Placed = Pick<Category, 'id' | 'name' | 'kind' | 'parentId'>;

/** The one spending category named exactly "Other", as import files unsorted spending there */
const isOther = (c: Placed) => c.kind === 'expense' && c.parentId == null && c.name === 'Other';

/** One of the six colours from an id, the same every time (FNV-1a over its characters) */
function fromId(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return COLOURS[(hash >>> 0) % COLOURS.length];
}

/** The CSS colour of the category with `id` in `categories` */
export function categoryColour(categories: readonly Placed[], id: string): string {
  const category = categories.find((c) => c.id === id);
  if (category == null) return GREY;
  if (category.kind === 'income') return INCOME;
  const top =
    category.parentId == null ? category : categories.find((c) => c.id === category.parentId);
  if (top == null || isOther(top)) return GREY;
  return BY_ID.get(top.id) ?? fromId(top.id);
}
