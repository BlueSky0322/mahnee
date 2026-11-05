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
  totals: readonly CategoryTotal[],
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
