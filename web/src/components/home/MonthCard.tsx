import { ActionIcon, Button } from '@mantine/core';
import { CaretDown, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useId, useMemo, useState } from 'react';
import type { Category, CategoryTotal, MonthSummary, MonthTrend } from '@shared/api';
import { DEFAULT_CURRENCY, FIRST_DAY } from '@shared/ledger';
import { navigate } from '../../hooks/useRoute';
import type { BudgetLine } from '../../ledger/budgets';
import { budgetLines } from '../../ledger/budgets';
import type { CategoryRollUp } from '../../ledger/derive';
import { rollUp } from '../../ledger/derive';
import type { Trend } from '../../ledger/useLedger';
import { useCategories, useMonthSummary, useMonthTrend } from '../../ledger/useLedger';
import { addMonths, monthHeading, thisMonth } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './MonthCard.module.css';
import type { MonthAmount } from './TwelveMonths';
import TwelveMonths from './TwelveMonths';

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
// of its budget, or how far over it is. Every category row, Spent and Received open in
// place to their last 12 months, ending at the month shown. The arrows step between
// months, up to this one; an earlier month is in the address (?month=2026-10), so Back
// returns.
export default function MonthCard({ month }: { month: string | null }) {
  const current = thisMonth();
  const shown = month ?? current;
  const { summary, failed, retry } = useMonthSummary(shown);
  // Read with the month, so it's there at once when a row is opened, and offline; the
  // month never waits on it
  const trend = useMonthTrend(shown);
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
          trend={trend}
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

/** Spending or income: which of a month's totals a row counts */
type Side = 'spent' | 'income';

/**
 * The 12 months ending at the month shown, as the card reads them: each month's spending
 * and income in total, and by top-level category rolled up as the month's own rows are
 * (rollUp), so the month shown is the card's figures
 */
interface Year {
  months: string[];
  total: Record<Side, number[]>;
  byCategory: Record<Side, CategoryRollUp[][]>;
}

function readYear(trend: MonthTrend, categories: Category[]): Year {
  return {
    months: trend.months.map((m) => m.month),
    total: {
      spent: trend.months.map((m) => m.spentCents),
      income: trend.months.map((m) => m.incomeCents),
    },
    byCategory: {
      spent: trend.months.map((m) => rollUp(m.spentByCategory, categories)),
      income: trend.months.map((m) => rollUp(m.incomeByCategory, categories)),
    },
  };
}

/** What one row opens to: its 12 months once read, and how to ask again */
interface Over {
  /** A top-level category's 12 months, or all of a side's when `categoryId` is null */
  amounts: (side: Side, categoryId: string | null) => MonthAmount[] | null;
  failed: boolean;
  retry: () => void;
}

function useOver(trend: Trend, categories: Category[]): Over {
  const year = useMemo(
    () => (trend.trend == null ? null : readYear(trend.trend, categories)),
    [trend.trend, categories],
  );
  return {
    amounts: (side, categoryId) =>
      year == null
        ? null
        : year.months.map((month, i) => ({
            month,
            cents:
              categoryId == null
                ? year.total[side][i]
                : year.byCategory[side][i].find((top) => top.id === categoryId)?.cents ?? 0,
          })),
    failed: trend.failed,
    retry: trend.retry,
  };
}

function Totals({
  summary,
  categories,
  trend,
  isCurrent,
}: {
  summary: MonthSummary;
  categories: Category[];
  trend: Trend;
  isCurrent: boolean;
}) {
  const [showSpent, setShowSpent] = useState(false);
  const [showIncome, setShowIncome] = useState(false);
  const ids = {
    left: useId(),
    spent: useId(),
    received: useId(),
    spending: useId(),
    income: useId(),
  };
  const over = useOver(trend, categories);
  const name = monthHeading(summary.month, { short: true });
  const isOver = summary.leftCents < 0;
  const leftLabel = `${isOver ? 'Over' : 'Left'} ${isCurrent ? 'this month' : `in ${name}`}`;
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
          className={isOver ? `${classes.leftAmount} ${classes.negative}` : classes.leftAmount}
        >
          {isOver && '−'}
          {money(Math.abs(summary.leftCents))}
        </span>
        {isOver && (
          <span className={classes.caption}>
            {money(-summary.leftCents)} more was spent than came in.
          </span>
        )}
      </div>

      <div className={classes.figures}>
        <Figure
          label="Spent"
          labelId={ids.spent}
          cents={summary.spentCents}
          open={showSpent}
          controls={ids.spending}
          onToggle={() => setShowSpent((shown) => !shown)}
        />
        <Figure
          label="Received"
          labelId={ids.received}
          cents={summary.incomeCents}
          open={showIncome}
          controls={ids.income}
          onToggle={() => setShowIncome((shown) => !shown)}
        />
      </div>

      {showSpent && (
        <TwelveMonths
          id={ids.spending}
          name="Spending"
          months={over.amounts('spent', null)}
          failed={over.failed}
          retry={over.retry}
        />
      )}

      {showIncome && (
        <div
          id={ids.income}
          className={classes.group}
        >
          {summary.incomeByCategory.length > 0 && (
            <CategoryRows
              label="Income by category"
              side="income"
              totals={summary.incomeByCategory}
              ofCents={summary.incomeCents}
              categories={categories}
              over={over}
            />
          )}
          <TwelveMonths
            name="Income"
            months={over.amounts('income', null)}
            failed={over.failed}
            retry={over.retry}
          />
        </div>
      )}

      <Budgets lines={budgetLines(summary, categories)} />

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
          side="spent"
          totals={summary.spentByCategory}
          ofCents={summary.spentCents}
          categories={categories}
          over={over}
        />
      )}
    </div>
  );
}

/** Spent or Received: its amount for the month, opening to more beneath the figures */
function Figure({
  label,
  labelId,
  cents,
  open,
  controls,
  onToggle,
}: {
  label: string;
  labelId: string;
  cents: number;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`${classes.figure} ${classes.figureButton}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span
        id={labelId}
        className={classes.figureLabel}
      >
        {label}
        {open ? (
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
        aria-labelledby={labelId}
        className={classes.figureAmount}
      >
        {money(cents)}
      </span>
    </button>
  );
}

/**
 * Top-level categories, largest first, each with a bar for its share of `ofCents`. Each
 * opens to show its subcategories (if any) and what was filed under it directly, then its
 * last 12 months.
 */
function CategoryRows({
  label,
  side,
  totals,
  ofCents,
  categories,
  over,
}: {
  label: string;
  side: Side;
  totals: CategoryTotal[];
  ofCents: number;
  categories: Category[];
  over: Over;
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
              months={open.has(top.id) ? over.amounts(side, top.id) : null}
              over={over}
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
  months,
  over,
}: {
  top: CategoryRollUp;
  ofCents: number;
  open: boolean;
  onToggle: () => void;
  /** Its last 12 months, when open and read */
  months: MonthAmount[] | null;
  over: Over;
}) {
  const insideId = useId();
  // A share of the bar's width, for drawing only: the amounts themselves stay in cents
  const share = ofCents > 0 ? Math.max(1, Math.round((top.cents / ofCents) * 100)) : 0;
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
        <span className={classes.rowLine}>
          <span className={classes.rowName}>{top.name}</span>
          <span className="sr-only">, </span>
          <span className={classes.rowAmount}>{money(top.cents)}</span>
          {open ? (
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
          )}
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
      </button>
      {open && (
        <div
          id={insideId}
          className={classes.opened}
        >
          {top.subcategories.length > 0 && (
            <ul
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
          <TwelveMonths
            name={top.name}
            months={months}
            failed={over.failed}
            retry={over.retry}
          />
        </div>
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
