import { useMemo } from 'react';
import { useCurrency } from '../profile/ProfileContext';
import { formatAmount, formatMoney } from '../utils/money';

/**
 * Money as it's shown, in the currency amounts are in now (useCurrency): money(cents) with
 * the symbol ("RM 248.00"), amount(cents) without it ("248.00")
 */
export function useMoney() {
  const currency = useCurrency();
  return useMemo(
    () => ({
      currency,
      money: (cents: number) => formatMoney(cents, currency),
      amount: (cents: number) => formatAmount(cents, currency),
    }),
    [currency],
  );
}
