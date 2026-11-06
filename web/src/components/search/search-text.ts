import type { CategoryNode } from '../../ledger/category-tree';

// Search's words: how many transactions, and categories as they're picked

/** "1 transaction", "80 transactions" */
export const transactionsText = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`;

/** A kind's listed categories to pick from: each top-level one, then those under it */
export function categoryOptions(nodes: CategoryNode[]) {
  return nodes.flatMap((node) => [
    { value: node.id, label: node.name },
    ...node.subcategories.map((c) => ({ value: c.id, label: `${node.name} › ${c.name}` })),
  ]);
}
