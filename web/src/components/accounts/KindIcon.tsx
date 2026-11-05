import { Bank, CreditCard, Money, Wallet } from '@phosphor-icons/react';
import type { AccountKind } from '@shared/ledger';

// How each kind of account is drawn

const ICONS = { cash: Money, bank: Bank, card: CreditCard, ewallet: Wallet };

export default function KindIcon({ kind, size = 20 }: { kind: AccountKind; size?: number }) {
  const Icon = ICONS[kind];
  return (
    <Icon
      size={size}
      aria-hidden
    />
  );
}
