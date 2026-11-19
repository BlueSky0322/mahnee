import type { BudgetLine } from '../../ledger/budgets';
import { useMoney } from '../../hooks/useMoney';
import Bar from '../ui/Bar';
import type { PlanMonth } from './plan-month';
import { budgetWords } from './plan-text';

const BAR_STATE = { onTrack: 'on-track', faster: 'faster', over: 'over' } as const;

/** A budget's bar: spent against what's available, with today marked on this month only */
export default function BudgetBar({ line, shown }: { line: BudgetLine; shown: PlanMonth }) {
  const { currency } = useMoney();
  const words = budgetWords(line, shown.at, { short: false, currency });
  return (
    <Bar
      label={words.label}
      spent={line.availableCents > 0 ? (line.spentCents * 100) / line.availableCents : 100}
      today={shown.isCurrent ? (shown.at.day * 100) / shown.at.days : null}
      state={BAR_STATE[words.pace]}
    />
  );
}
