import type { CategoryKind } from '@shared/categories';

// Categories as people read them

/** Each kind's list, as its heading names it */
export const KIND_LABELS: Record<CategoryKind, string> = {
  expense: 'Spending',
  income: 'Income',
};
