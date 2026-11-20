import type { Transaction } from '@shared/api';
import { formatMoney } from '../../utils/money';
import { CONVERSION_PENDING } from './typed-amount';
import classes from './MainAmount.module.css';

/**
 * What it came to in the home currency, beside what was typed ("RM 15.30"), or "conversion
 * pending" before it's known; nothing otherwise
 */
export default function MainAmount({
  t,
  currency,
}: {
  t: Pick<Transaction, 'original' | 'amountCents'>;
  currency: string;
}) {
  if (t.original == null) return null;
  return (
    <span className={classes.main}>
      {t.original.pending ? CONVERSION_PENDING : formatMoney(t.amountCents, currency)}
    </span>
  );
}
