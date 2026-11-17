import type { Category, CategoryTotal } from '@shared/api';

// A month's totals by category as Home shows them: each subcategory's amount rolled up
// into its top-level category, so Food's total is what was filed under Food itself plus
// what was filed under each of its subcategories. Archived categories still count:
// what was spent in them was still spent.

/** A subcategory's share of its category's total */
export interface SubcategoryTotal {
  id: string;
  name: string;
  cents: number;
}

/** A top-level category's total, with how it's made up */
export interface CategoryRollUp {
  id: string;
  name: string;
  /** Everything filed under it: its own and its subcategories' */
  cents: number;
  /** Filed under the category itself rather than one of its subcategories */
  ownCents: number;
  /** Its subcategories with anything filed under them, largest first */
  subcategories: SubcategoryTotal[];
}

/** What a category not in the person's list (yet) is called */
export const UNKNOWN_CATEGORY = 'Unknown category';

const largestFirst = <T extends { cents: number; name: string }>(a: T, b: T) =>
  b.cents - a.cents || a.name.localeCompare(b.name);

/**
 * The top-level categories with anything filed under them, largest first, each with its
 * subcategories' amounts and its own. A subcategory whose parent isn't known stands on
 * its own, and a category not known at all is UNKNOWN_CATEGORY.
 */
export function rollUp(
  totals: readonly Pick<CategoryTotal, 'categoryId' | 'cents'>[],
  categories: readonly Category[],
): CategoryRollUp[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const tops = new Map<string, CategoryRollUp>();
  for (const { categoryId, cents } of totals) {
    const category = byId.get(categoryId);
    const parent = category?.parentId == null ? null : byId.get(category.parentId);
    const top = parent ?? category;
    const topId = top?.id ?? categoryId;
    const rolled = tops.get(topId) ?? {
      id: topId,
      name: top?.name ?? UNKNOWN_CATEGORY,
      cents: 0,
      ownCents: 0,
      subcategories: [],
    };
    rolled.cents += cents;
    if (parent == null || category == null) rolled.ownCents += cents;
    else rolled.subcategories.push({ id: categoryId, name: category.name, cents });
    tops.set(topId, rolled);
  }
  const rolled = [...tops.values()];
  for (const top of rolled) top.subcategories.sort(largestFirst);
  return rolled.sort(largestFirst);
}

/** A subcategory's share, with how many entries make it */
export interface SubcategorySpending extends SubcategoryTotal {
  entries: number;
}

/** A top-level category's total as Plan lists it: how many entries make it, and who */
export interface CategorySpending extends Omit<CategoryRollUp, 'subcategories'> {
  /** Every entry filed under it, its subcategories' included */
  entries: number;
  /** Who was paid, when it is one entry in all and that entry names one; else null */
  payee: string | null;
  subcategories: SubcategorySpending[];
}

/**
 * rollUp, with each category's and subcategory's entries counted in, and the payee kept
 * only when the category and its subcategories hold a single entry in all
 */
export function rollUpEntries(
  totals: readonly Pick<CategoryTotal, 'categoryId' | 'cents' | 'entries' | 'payee'>[],
  categories: readonly Category[],
): CategorySpending[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const topOf = (categoryId: string) => {
    const category = byId.get(categoryId);
    const parent = category?.parentId == null ? null : byId.get(category.parentId);
    return (parent ?? category)?.id ?? categoryId;
  };
  const counts = new Map<string, { entries: number; payee: string | null }>();
  for (const { categoryId, entries, payee } of totals) {
    const topId = topOf(categoryId);
    const was = counts.get(topId);
    const all = (was?.entries ?? 0) + entries;
    counts.set(topId, { entries: all, payee: all === 1 ? payee ?? null : null });
  }
  const subEntries = new Map(totals.map((t) => [t.categoryId, t.entries]));
  return rollUp(totals, categories).map((top) => ({
    ...top,
    entries: counts.get(top.id)?.entries ?? 0,
    payee: counts.get(top.id)?.payee ?? null,
    subcategories: top.subcategories.map((sub) => ({
      ...sub,
      entries: subEntries.get(sub.id) ?? 0,
    })),
  }));
}
