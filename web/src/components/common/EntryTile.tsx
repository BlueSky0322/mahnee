import { TransferIcon } from '../ui/icons';
import type { Category, Transaction } from '@shared/api';
import { categoryColour } from '../../utils/category-colour';
import Tile from '../ui/Tile';

/** An entry's tile, on Activity, an account's page and Scheduled: its category's letter in its colour, or a transfer's arrows */
export default function EntryTile({
  t,
  categories,
}: {
  t: Pick<Transaction, 'kind' | 'categoryId'>;
  categories: Category[];
}) {
  if (t.kind === 'transfer') {
    return (
      <Tile>
        <TransferIcon size={18} />
      </Tile>
    );
  }
  const category = categories.find((c) => c.id === t.categoryId);
  const top = categories.find((c) => c.id === (category?.parentId ?? category?.id));
  return (
    <Tile
      name={top?.name ?? '?'}
      colour={categoryColour(categories, t.categoryId ?? '')}
    />
  );
}
