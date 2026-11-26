import type { ReactNode } from 'react';
import { FIRST_DAY } from '@shared/ledger';
import { addMonths } from '../../utils/date-input';
import { BackIcon, ForwardIcon } from './icons';
import classes from './MonthNavigation.module.css';

const FIRST_MONTH = FIRST_DAY.slice(0, 7);

interface MonthNavigationProps {
  month: string;
  nextDisabled: boolean;
  onStep: (month: string) => void;
  isDesktop: boolean;
  className?: string;
  children: ReactNode;
}

export default function MonthNavigation({
  month,
  nextDisabled,
  onStep,
  isDesktop,
  className,
  children,
}: MonthNavigationProps) {
  return (
    <div
      className={className == null ? classes.nav : `${classes.nav} ${className}`}
      data-desktop={isDesktop || undefined}
    >
      <button
        type="button"
        aria-label="Previous month"
        disabled={month <= FIRST_MONTH}
        onClick={() => onStep(addMonths(month, -1))}
      >
        <BackIcon size={20} />
      </button>
      {children}
      <button
        type="button"
        aria-label="Next month"
        disabled={nextDisabled}
        onClick={() => onStep(addMonths(month, 1))}
      >
        <ForwardIcon size={20} />
      </button>
    </div>
  );
}
