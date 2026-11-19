import { AlertIcon } from '../ui/icons';
import { useCurrency } from '../../profile/ProfileContext';
import { useId } from 'react';
import type { PeriodDay } from '@shared/period';
import type { BudgetLine } from '../../ledger/budgets';
import Bar from '../ui/Bar';
import classes from './Home.module.css';
import { budgetText } from './home-text';
import PageLink from './PageLink';

const BAR_STATE = { onTrack: 'on-track', faster: 'faster', over: 'over' } as const;

// Home's budgets: each one with what's left, a bar with a marker for how much of the month
// has gone (none once it's over), and how its spending goes against the month. Plan holds
// the rest. With none set, it says so and offers to set one.
export default function HomeBudgets({
  lines,
  at,
  isCurrent,
  short,
}: {
  lines: readonly BudgetLine[];
  at: PeriodDay;
  isCurrent: boolean;
  /** On a computer: figures without the symbol, as drawn */
  short: boolean;
}) {
  const homeCurrency = useCurrency();
  const titleId = useId();
  return (
    <section
      className={classes.budgets}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Budgets
        </h2>
        {lines.length > 0 && (
          <PageLink
            href="?plan"
            className={classes.more}
          >
            All of Plan
          </PageLink>
        )}
      </div>
      {lines.length === 0 ? (
        <div className={classes.inlineEmpty}>
          <p>No budgets yet.</p>
          <PageLink
            href="?settings=categories"
            push
            className={classes.lineButton}
          >
            Set a budget
          </PageLink>
        </div>
      ) : (
        <ul className={short ? classes.budgetGrid : classes.budgetList}>
          {lines.map((line) => {
            const text = budgetText(line, at, { short, currency: homeCurrency });
            const tone =
              text.pace === 'over' ? classes.neg : text.pace === 'faster' ? classes.due : '';
            return (
              <li
                key={line.id}
                className={classes.budget}
              >
                <div className={classes.budgetHead}>
                  <span className={classes.budgetName}>{line.name}</span>
                  <span className={`${classes.num} ${tone}`}>{text.left}</span>
                </div>
                <Bar
                  label={text.label}
                  spent={
                    line.availableCents > 0 ? (line.spentCents * 100) / line.availableCents : 100
                  }
                  today={isCurrent ? (at.day * 100) / at.days : null}
                  state={BAR_STATE[text.pace]}
                />
                <span className={`${classes.budgetMeta} ${tone}`}>
                  {/* A phone puts a warning sign before it; a computer the words alone */}
                  {text.pace === 'faster' && !short && (
                    <AlertIcon
                      size={14}
                      aria-hidden
                    />
                  )}
                  {text.meta}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
