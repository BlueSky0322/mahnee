import type { Category } from '@shared/api';

// A category as the screens name it: a subcategory with the category it's in

/** "Food", or "Food › Coffee" for a subcategory; "No category" for a transfer or one not known */
export function categoryName(categories: readonly Category[], id: string | null) {
  const category = categories.find((c) => c.id === id);
  if (category == null) return 'No category';
  const parent = categories.find((c) => c.id === category.parentId);
  return parent == null ? category.name : `${parent.name} › ${category.name}`;
}
