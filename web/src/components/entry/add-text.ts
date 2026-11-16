import type { Category, PayeeCategory } from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { whyNotUnder } from '@shared/categories';
import type { Keypad } from '@shared/keypad';
import { totalCents } from '@shared/keypad';
import type { TransactionKind } from '@shared/ledger';
import { MAX_TRANSACTION } from '@shared/ledger';
import type { CategoryNode } from '../../ledger/category-tree';
import { formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';
import { MAX_RECENT_CATEGORIES } from '../../ledger/last-used';

// Add's words and choices: what Save says it will do, the recent categories offered as
// chips, and what a payee typed says about where a new category belongs.

/** The words for the largest amount, when a key went past it */
export const LIMIT_TEXT = `Up to ${MAX_TRANSACTION.toLocaleString('en')}`;

/**
 * What Save says: "Save RM 12.50", "Move RM 12.50" for a transfer, or why it can't be
 * saved yet: "Type an amount", "The total is below zero", "Up to 10,000,000"
 */
export function saveLabel(kind: TransactionKind, keypad: Keypad, currency: string): string {
  if (keypad.tooMuch) return LIMIT_TEXT;
  const cents = totalCents(keypad.expr);
  if (cents === 0) return 'Type an amount';
  if (cents < 0) return 'The total is below zero';
  return `${kind === 'transfer' ? 'Move' : 'Save'} ${formatMoney(cents, currency)}`;
}

/** A category to pick, with the name the For row shows ("Food › Coffee") */
export type NamedCategory = Category & { fullName: string };

/** Every listed category of a kind, each top-level one followed by its subcategories */
export function listedCategories(nodes: readonly CategoryNode[]): NamedCategory[] {
  return nodes.flatMap((node) => [
    { ...node, fullName: node.name },
    ...node.subcategories.map((sub) => ({ ...sub, fullName: `${node.name} › ${sub.name}` })),
  ]);
}

/**
 * The five recent categories: those used lately on this device (newest first), then the
 * kind's top-level ones in their order, each once, none archived
 */
export function recentCategories(
  recentIds: readonly string[],
  nodes: readonly CategoryNode[],
): NamedCategory[] {
  const listed = listedCategories(nodes);
  const chosen: NamedCategory[] = [];
  const add = (c: NamedCategory | undefined) => {
    if (c != null && chosen.length < MAX_RECENT_CATEGORIES && !chosen.some((o) => o.id === c.id)) {
      chosen.push(c);
    }
  };
  for (const id of recentIds) add(listed.find((c) => c.id === id));
  for (const node of nodes) add(listed.find((c) => c.id === node.id));
  return chosen;
}

/**
 * Where a new category might go, from the payee typed: under the category (or its own
 * category, for a subcategory) the payee was last filed in, with "Tealive was in Food".
 * None when the payee isn't known for this kind, its category is no longer listed, or
 * there's no room under it.
 */
export function payeeHint(
  payee: string,
  kind: CategoryKind,
  payees: readonly PayeeCategory[],
  categories: readonly Category[],
): { parentId: string; parentName: string; text: string } | null {
  const typed = payee.trim().toLowerCase();
  if (typed === '') return null;
  const known = payees.find((p) => p.kind === kind && p.payee.trim().toLowerCase() === typed);
  const category = categories.find((c) => c.id === known?.categoryId);
  if (known == null || category == null || category.archived) return null;
  const parent =
    category.parentId == null ? category : categories.find((c) => c.id === category.parentId);
  if (parent == null || parent.archived) return null;
  if (whyNotUnder(categories, { id: '', kind }, parent.id) != null) return null;
  return {
    parentId: parent.id,
    parentName: parent.name,
    text: `${known.payee} was in ${categoryName(categories, category.id)}`,
  };
}
