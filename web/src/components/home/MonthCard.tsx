import { ActionIcon, Button } from '@mantine/core';
import { CaretDown, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import type { Category, CategoryTotal, MonthSummary } from '@shared/api';
import { DEFAULT_CURRENCY, FIRST_DAY } from '@shared/ledger';
import { navigate } from '../../hooks/useRoute';
import type { BudgetLine } from '../../ledger/budgets';
import { budgetLines } from '../../ledger/budgets';
import type { CategoryRollUp } from '../../ledger/derive';
import { rollUp } from '../../ledger/derive';
import { useCategories, useMonthSummary } from '../../ledger/useLedger';
import { addMonths, monthHeading, thisMonth } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './MonthCard.module.css';

/** The earliest month a transaction can be in */
const FIRST_MONTH = FIRST_DAY.slice(0, 7);
/** Placeholder rows while the month loads */
const LOADING_ROWS = 3;

/** Every total here is in the one currency accounts are kept in for now */
const money = (cents: number) => formatMoney(cents, DEFAULT_CURRENCY);

/** Opens Home on `month`: this month's address names none */
const showMonth = (month: string) => navigate(month >= thisMonth() ? '' : `?month=${month}`);

// The top of Home: a month at a glance. What's left (received less spent) is the
// largest number, then what was spent and received, then where the spending went, by
// top-level category with its subcategories inside. Each budgeted category says what's left
// of its budget, or how far over it is. The arrows step between months, up
// to this one; an earlier month is in the address (?month=2026-10), so Back returns.
export default function MonthCard({ month }: { month: string | null }) {
  const current = thisMonth();
  const shown = month ?? current;
  const { summary, failed, retry } = useMonthSummary(shown);
  const { categories } = useCategories();
  const titleId = useId();

  return (
    <section
      className={classes.card}
      aria-labelledby={titleId}
    >
      <div className={classes.header}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Previous month"
          disabled={shown <= FIRST_MONTH}
          onClick={() => showMonth(addMonths(shown, -1))}
        >
          <CaretLeft size={18} />
        </ActionIcon>
        <h2
          id={titleId}
          className={classes.title}
        >
          {monthHeading(shown)}
        </h2>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label="Next month"
          disabled={shown >= current}
          onClick={() => showMonth(addMonths(shown, 1))}
        >
          <CaretRight size={18} />
        </ActionIcon>
      </div>

      {summary == null || categories == null ? (
        failed ? (
          <div className={classes.failed}>
            <p className={classes.muted}>Couldn't load this month.</p>
            <Button
              variant="default"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Placeholder />
        )
      ) : (
        <Totals
          // A month opened afresh starts with every category folded
          key={shown}
          summary={summary}
          categories={categories}
          isCurrent={shown === current}
        />
      )}
    </section>
  );
}

function Placeholder() {
  return (
    <Loading
      label="Loading this month"
      className={classes.body}
    >
      <div className={classes.left}>
        <Skeleton
          width={110}
          height={14}
        />
        <Skeleton
          width={170}
          height={40}
        />
      </div>
      <div className={classes.figures}>
        {[0, 1].map((i) => (
          <div
            key={i}
            className={classes.figure}
          >
            <Skeleton
              width={64}
              height={13}
            />
            <Skeleton
              width={96}
              height={18}
            />
          </div>
        ))}
      </div>
      <div className={classes.rows}>
        {Array.from({ length: LOADING_ROWS }, (_, i) => (
          <div
            key={i}
            className={classes.placeholderRow}
          >
            <Skeleton
              width={`${60 - i * 15}%`}
              height={14}
            />
            <Skeleton
              width="100%"
              height={6}
            />
          </div>
        ))}
      </div>
    </Loading>
  );
}

function Totals({
  summary,
  categories,
  isCurrent,
}: {
  summary: MonthSummary;
  categories: Category[];
  isCurrent: boolean;
}) {
  const [showIncome, setShowIncome] = useState(false);
  const ids = { left: useId(), spent: useId(), received: useId(), income: useId() };
  const name = monthHeading(summary.month, { short: true });
  const over = summary.leftCents < 0;
  const leftLabel = `${over ? 'Over' : 'Left'} ${isCurrent ? 'this month' : `in ${name}`}`;
  const nothing = summary.spentCents === 0 && summary.incomeCents === 0;

  return (
    <div className={classes.body}>
      <div className={classes.left}>
        <span
          id={ids.left}
          className={classes.leftLabel}
        >
          {leftLabel}
        </span>
        <span
          aria-labelledby={ids.left}
          className={over ? `${classes.leftAmount} ${classes.negative}` : classes.leftAmount}
        >
          {over && '−'}
          {money(Math.abs(summary.leftCents))}
        </span>
        {over && (
          <span className={classes.caption}>
            {money(-summary.leftCents)} more was spent than came in.
          </span>
        )}
      </div>

      <div className={classes.figures}>
        <div className={classes.figure}>
          <span
            id={ids.spent}
            className={classes.figureLabel}
          >
            Spent
          </span>
          <span
            aria-labelledby={ids.spent}
            className={classes.figureAmount}
          >
            {money(summary.spentCents)}
          </span>
        </div>
        {summary.incomeByCategory.length === 0 ? (
          <div className={classes.figure}>
            <span
              id={ids.received}
              className={classes.figureLabel}
            >
              Received
            </span>
            <span
              aria-labelledby={ids.received}
              className={classes.figureAmount}
            >
              {money(summary.incomeCents)}
            </span>
          </div>
        ) : (
          <button
            type="button"
            className={`${classes.figure} ${classes.figureButton}`}
            aria-expanded={showIncome}
            aria-controls={ids.income}
            onClick={() => setShowIncome((shown) => !shown)}
          >
            <span
              id={ids.received}
              className={classes.figureLabel}
            >
              Received
              {showIncome ? (
                <CaretDown
                  size={12}
                  aria-hidden
                />
              ) : (
                <CaretRight
                  size={12}
                  aria-hidden
                />
              )}
            </span>
            <span
              aria-labelledby={ids.received}
              className={classes.figureAmount}
            >
              {money(summary.incomeCents)}
            </span>
          </button>
        )}
      </div>

      <Budgets lines={budgetLines(summary, categories)} />

      {showIncome && (
        <div id={ids.income}>
          <CategoryRows
            label="Income by category"
            totals={summary.incomeByCategory}
            ofCents={summary.incomeCents}
            categories={categories}
          />
        </div>
      )}

      {nothing ? (
        <p className={classes.muted}>
          Nothing spent or received in {name}
          {isCurrent ? ' yet' : ''}.
        </p>
      ) : summary.spentCents === 0 ? (
        <p className={classes.muted}>
          Nothing spent in {name}
          {isCurrent ? ' yet' : ''}.
        </p>
      ) : (
        <CategoryRows
          label="Spending by category"
          totals={summary.spentByCategory}
          ofCents={summary.spentCents}
          categories={categories}
        />
      )}
    </div>
  );
}

/**
 * Top-level categories, largest first, each with a bar for its share of `ofCents`. One
 * with subcategories opens to show them, and what was filed under it directly.
 */
function CategoryRows({
  label,
  totals,
  ofCents,
  categories,
}: {
  label: string;
  totals: CategoryTotal[];
  ofCents: number;
  categories: Category[];
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const headingId = useId();
  return (
    <div className={classes.group}>
      <h3
        id={headingId}
        className={classes.groupTitle}
      >
        {label}
      </h3>
      <ul
        className={classes.rows}
        aria-labelledby={headingId}
      >
        {rollUp(totals, categories).map((top) => (
          <li key={top.id}>
            <CategoryRow
              top={top}
              ofCents={ofCents}
              open={open.has(top.id)}
              onToggle={() => toggle(top.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CategoryRow({
  top,
  ofCents,
  open,
  onToggle,
}: {
  top: CategoryRollUp;
  ofCents: number;
  open: boolean;
  onToggle: () => void;
}) {
  const insideId = useId();
  // A share of the bar's width, for drawing only: the amounts themselves stay in cents
  const share = ofCents > 0 ? Math.max(1, Math.round((top.cents / ofCents) * 100)) : 0;
  const content = (
    <>
      <span className={classes.rowLine}>
        <span className={classes.rowName}>{top.name}</span>
        <span className="sr-only">, </span>
        <span className={classes.rowAmount}>{money(top.cents)}</span>
        {top.subcategories.length > 0 &&
          (open ? (
            <CaretDown
              size={14}
              className={classes.caret}
              aria-hidden
            />
          ) : (
            <CaretRight
              size={14}
              className={classes.caret}
              aria-hidden
            />
          ))}
      </span>
      <span
        className={classes.track}
        aria-hidden
      >
        <span
          className={classes.bar}
          style={{ width: `${share}%` }}
        />
      </span>
    </>
  );
  if (top.subcategories.length === 0) return <div className={classes.row}>{content}</div>;
  return (
    <>
      <button
        type="button"
        className={`${classes.row} ${classes.rowButton}`}
        aria-label={`${top.name}, ${money(top.cents)}`}
        aria-expanded={open}
        aria-controls={insideId}
        onClick={onToggle}
      >
        {content}
      </button>
      {open && (
        <ul
          id={insideId}
          className={classes.inside}
          aria-label={`In ${top.name}`}
        >
          {top.subcategories.map((sub) => (
            <li
              key={sub.id}
              className={classes.insideRow}
            >
              <span className={classes.rowName}>{sub.name}</span>
              <span className="sr-only">, </span>
              <span className={classes.insideAmount}>{money(sub.cents)}</span>
            </li>
          ))}
          {top.ownCents > 0 && (
            <li className={classes.insideRow}>
              <span className={classes.rowName}>Filed under {top.name} itself</span>
              <span className="sr-only">, </span>
              <span className={classes.insideAmount}>{money(top.ownCents)}</span>
            </li>
          )}
        </ul>
      )}
    </>
  );
}

/** "−RM 20.00" below zero, "RM 30.00" otherwise */
const signedMoney = (cents: number) => `${cents < 0 ? '−' : ''}${money(Math.abs(cents))}`;

/**
 * Each budget: what's left of it ("RM 120.00 left of RM 300.00") or how far over it is
 * ("RM 40.00 over", in the negative colour), what carried over from last month, and a bar
 * for how much of it is spent
 */
function Budgets({ lines }: { lines: BudgetLine[] }) {
  const headingId = useId();
  if (lines.length === 0) return null;
  return (
    <div className={classes.group}>
      <h3
        id={headingId}
        className={classes.groupTitle}
      >
        Budgets
      </h3>
      <ul
        className={classes.rows}
        aria-labelledby={headingId}
      >
        {lines.map((line) => {
          const over = line.leftCents < 0;
          // A share of the bar's width, for drawing only: the amounts stay in cents
          const share =
            over || line.availableCents <= 0
              ? 100
              : Math.round((line.spentCents / line.availableCents) * 100);
          return (
            <li
              key={line.id}
              className={classes.row}
            >
              <span className={classes.rowLine}>
                <span className={classes.rowName}>{line.name}</span>
                <span className="sr-only">, </span>
                <span
                  className={
                    over ? `${classes.budgetLeft} ${classes.negative}` : classes.budgetLeft
                  }
                >
                  {over
                    ? `${money(-line.leftCents)} over`
                    : `${money(line.leftCents)} left of ${money(line.availableCents)}`}
                </span>
              </span>
              {line.carriedCents !== 0 && (
                <>
                  <span className="sr-only">, </span>
                  <span className={classes.budgetCarried}>
                    incl. {signedMoney(line.carriedCents)} carried over
                  </span>
                </>
              )}
              <span
                className={classes.track}
                aria-hidden
              >
                <span
                  className={over ? `${classes.bar} ${classes.barOver}` : classes.bar}
                  style={{ width: `${share}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
