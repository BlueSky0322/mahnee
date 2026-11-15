import type { Category } from '@shared/api';

// A colour for each category, so spending is easier to tell apart at a glance; its name is
// always shown too. Nothing is stored: each top-level spending category takes one of six
// colours (--c1 to --c6 in theme/tokens.css) from its place in the list, archived ones
// keeping theirs so the others don't shift, and they repeat after six. A subcategory wears
// its parent's. "Other", where unsorted spending goes, stays a quiet grey and takes no
// colour from the rest; income is green.

/** The six colours, in the order they're given out */
const COLOURS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

const GREY = 'var(--line-2)';
const INCOME = 'var(--pos)';

type Placed = Pick<Category, 'id' | 'name' | 'kind' | 'parentId' | 'position'>;

/** The one spending category named exactly "Other", as import files unsorted spending there */
const isOther = (c: Placed) => c.kind === 'expense' && c.parentId == null && c.name === 'Other';

/** The CSS colour of the category with `id`, worked out from the whole list */
export function categoryColour(categories: readonly Placed[], id: string): string {
  const category = categories.find((c) => c.id === id);
  if (category == null) return GREY;
  if (category.kind === 'income') return INCOME;
  const top =
    category.parentId == null ? category : categories.find((c) => c.id === category.parentId);
  if (top == null || isOther(top)) return GREY;
  const coloured = categories
    .filter((c) => c.kind === 'expense' && c.parentId == null && !isOther(c))
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const place = coloured.findIndex((c) => c.id === top.id);
  return COLOURS[place % COLOURS.length];
}
