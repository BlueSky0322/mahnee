import { BankIcon, CardIcon, CashIcon, EwalletIcon } from '../ui/icons';
import type { AccountKind } from '@shared/ledger';

// How each kind of account is drawn

const ICONS = { cash: CashIcon, bank: BankIcon, card: CardIcon, ewallet: EwalletIcon };

export default function KindIcon({ kind, size = 20 }: { kind: AccountKind; size?: number }) {
  const Icon = ICONS[kind];
  return (
    <Icon
      size={size}
      aria-hidden
    />
  );
}
