import type { Category } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { siblingsOf } from '@shared/categories';

// A person's categories as the screens list them: each kind's top-level categories in
// their order, each with its subcategories, and apart from them the archived ones.

/** A listed top-level category, with its listed subcategories in their order */
export interface CategoryNode extends Category {
  subcategories: Category[];
}

export interface CategoryTree {
  /** Listed: top-level categories that aren't archived, by kind */
  listed: Record<CategoryKind, CategoryNode[]>;
  /**
   * Taken out of the list, to bring back: archived top-level categories, and archived
   * subcategories of listed ones, spending first. A subcategory of an archived category
   * is out of the list with it and comes back with it, so it isn't counted here.
   */
  archived: Category[];
}

export function categoryTree(categories: Category[]): CategoryTree {
  const tops = (kind: CategoryKind) => siblingsOf(categories, kind, null);
  const subsOf = (parent: Category) => siblingsOf(categories, parent.kind, parent.id);
  const listedOf = (kind: CategoryKind): CategoryNode[] =>
    tops(kind)
      .filter((c) => !c.archived)
      .map((c) => ({ ...c, subcategories: subsOf(c).filter((s) => !s.archived) }));
  const archivedOf = (kind: CategoryKind) =>
    tops(kind).flatMap((c) => (c.archived ? [c] : subsOf(c).filter((s) => s.archived)));
  return {
    listed: { expense: listedOf('expense'), income: listedOf('income') },
    archived: [...archivedOf('expense'), ...archivedOf('income')],
  };
}
