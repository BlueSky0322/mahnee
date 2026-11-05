// What a person's spending and income is sorted into: the kinds, limits and default
// categories, and the rule for what can sit under what. The app uses the rule to offer
// only the moves it allows, saying why the others aren't; the Worker refuses any it
// doesn't allow, and is the authority.
//
// Categories go one level deep: a top-level category can have subcategories, and a
// subcategory has none of its own. A subcategory is always its parent's kind.

import type { Category } from './api';

/** Spending (money going out) or income (money coming in) */
export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const isCategoryKind = (v: unknown): v is CategoryKind =>
  (CATEGORY_KINDS as readonly unknown[]).includes(v);

/** The most categories one person can have, archived ones and subcategories included */
export const MAX_CATEGORIES = 200;

/** The most subcategories one category can have, archived ones included */
export const MAX_SUBCATEGORIES = 50;

/** The longest a category's name can be, once trimmed */
export const MAX_CATEGORY_NAME = 40;

/** A category's name as typed, trimmed; null when it's missing, empty or too long */
export function readCategoryName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 && name.length <= MAX_CATEGORY_NAME ? name : null;
}

const defaults = (kind: CategoryKind, first: number, names: string[]): Category[] =>
  names.map((name, i) => ({
    id: `c0000000000000${(first + i).toString(16).padStart(2, '0')}`,
    name,
    kind,
    parentId: null,
    position: i,
    archived: false,
  }));

/**
 * What a person starts with. Their ids never change, so a change made to one before
 * they're saved (renaming Food, say) names the same row once they are.
 */
export const DEFAULT_CATEGORIES: readonly Category[] = [
  ...defaults('expense', 1, [
    'Food',
    'Transport',
    'Groceries',
    'Bills',
    'Shopping',
    'Health',
    'Fun',
    'Other',
  ]),
  ...defaults('income', 9, ['Salary', 'Other income']),
];

/**
 * A person's categories: the ones saved, or the defaults while none are. Nothing is
 * saved until their first change of any kind, which saves the defaults with it, and
 * archived categories are never deleted, so none saved means they've never had any.
 */
export const categoriesOrDefaults = (saved: readonly Category[]): Category[] =>
  (saved.length > 0 ? saved : DEFAULT_CATEGORIES).map((c) => ({ ...c }));

/** What the rules need to know of a category */
type Placed = Pick<Category, 'id' | 'name' | 'kind' | 'parentId' | 'archived'>;

/**
 * Why a category can't go under any other, or null when it can: one with subcategories
 * of its own stays at the top level, archived ones included, since they'd come back two
 * deep
 */
export function whyStaysOnTop(
  categories: readonly Placed[],
  category: Pick<Placed, 'id'>,
): string | null {
  if (!categories.some((c) => c.parentId === category.id)) return null;
  const name = categories.find((c) => c.id === category.id)?.name ?? 'It';
  return `${name} has subcategories, so it stays at the top level`;
}

/**
 * Why `category` (of `kind`, new or already there) can't go under `parentId`, or null
 * when it can. Top level (null) is always allowed. The parent must exist (checked
 * apart, as it's answered differently), be top level, be listed, be the same kind, and
 * have room; a category with subcategories of its own stays at the top level.
 */
export function whyNotUnder(
  categories: readonly Placed[],
  category: Pick<Placed, 'id' | 'kind'>,
  parentId: string | null,
): string | null {
  if (parentId == null) return null;
  const parent = categories.find((c) => c.id === parentId);
  if (parent == null) return 'Category not found';
  const self = categories.find((c) => c.id === category.id);
  if (parent.id === category.id) return "A category can't go under itself";
  if (self != null && self.parentId === parentId) return null;
  const staysOnTop = whyStaysOnTop(categories, category);
  if (staysOnTop != null) return staysOnTop;
  if (parent.parentId != null) return `${parent.name} is a subcategory itself`;
  if (parent.kind !== category.kind) return 'Spending and income categories stay apart';
  if (parent.archived) return `${parent.name} is archived`;
  if (categories.filter((c) => c.parentId === parentId).length >= MAX_SUBCATEGORIES) {
    return `${parent.name} has ${MAX_SUBCATEGORIES} subcategories, the most it can have`;
  }
  return null;
}

/**
 * The categories side by side with one of `kind` under `parentId` (null: the top
 * level), archived ones included, in their order
 */
export function siblingsOf<T extends Pick<Category, 'id' | 'kind' | 'parentId' | 'position'>>(
  categories: readonly T[],
  kind: CategoryKind,
  parentId: string | null,
): T[] {
  return categories
    .filter((c) => c.kind === kind && c.parentId === parentId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Where a category goes when it joins `siblings`: last */
export const nextPosition = (siblings: readonly Pick<Category, 'position'>[]) =>
  siblings.reduce((last, c) => Math.max(last, c.position + 1), 0);

/**
 * The ids of `siblings` (in their order) once `id` is moved to `index` among them,
 * counted with it taken out: the new order, positions from 0
 */
export function reorder(siblings: readonly Pick<Category, 'id'>[], id: string, index: number) {
  const others = siblings.map((c) => c.id).filter((other) => other !== id);
  const at = Math.max(0, Math.min(index, others.length));
  return [...others.slice(0, at), id, ...others.slice(at)];
}
