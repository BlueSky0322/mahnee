import { Button, Switch, TextInput } from '@mantine/core';
import { useMoney } from '../../hooks/useMoney';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Category, MonthBudget, MonthTrend } from '@shared/api';
import type { AgainstAverage } from '@shared/trend';
import { categoriesOrDefaults } from '@shared/categories';
import { againstAverage } from '@shared/trend';
import { goUp } from '../../hooks/useRoute';
import type { BudgetLine } from '../../ledger/budgets';
import { budgetLines } from '../../ledger/budgets';
import { change } from '../../ledger/ledger';
import { rollUp, rollUpEntries } from '../../ledger/derive';
import { useMonthSummary, useMonthTrend, useWholeLedger } from '../../ledger/useLedger';
import { useProfile, useCurrency } from '../../profile/ProfileContext';
import { categoryColour } from '../../utils/category-colour';
import { monthHeading, monthLabel } from '../../utils/date-input';
import { budgetText, readBudget } from '../categories/category-text';
import PageLink from '../home/PageLink';
import Skeleton, { Loading } from '../ui/Skeleton';
import classes from './Plan.module.css';
import BudgetBar from './BudgetBar';
import { activityAddress, planAddress } from './plan-address';
import type { PlanMonth } from './plan-month';
import { entriesText, usualParts, usualText, yearComparison } from './plan-text';
import BackButton from '../ui/BackButton';

/** One of the 12 months: what was spent or received in it */
export interface MonthAmount {
  month: string;
  cents: number;
}

/**
 * The category's spending, or for an income category what came in, in each of the 12 months
 * ending at the month shown
 */
function yearOf(trend: MonthTrend, categories: Category[], category: Category): MonthAmount[] {
  return trend.months.map((m) => ({
    month: m.month,
    cents:
      rollUp(category.kind === 'income' ? m.incomeByCategory : m.spentByCategory, categories).find(
        (top) => top.id === category.id,
      )?.cents ?? 0,
  }));
}

// A category over 12 months (R-Category; on a computer the right pane of R-Desk-Plan): what
// was spent in it in the month shown (for an income category, what came in) against the
// usual (the average of the 11 months before), its last 12 months, what's inside it, its
// budget, and its entries a tap away in Activity.
// On phones and tablets it is a page of its own under Plan (`page`), with Back to Plan; on
// a computer it sits beside Plan's table (`pane`), where this month's budget is changed.
export default function CategoryView({
  id,
  shown,
  variant,
  focusBudget = null,
}: {
  id: string;
  shown: PlanMonth;
  variant: 'page' | 'pane';
  /** Puts the cursor in the budget field once, when "Set a budget" opened the pane */
  focusBudget?: { id: string } | null;
}) {
  const { money, amount } = useMoney();
  const { data: ledger, failed: ledgerFailed } = useWholeLedger();
  const { summary, failed, retry } = useMonthSummary(shown.month);
  const trend = useMonthTrend(shown.month);
  const titleId = useId();
  const isPage = variant === 'page';
  const back = () => goUp(planAddress({ month: shown.isCurrent ? null : shown.month }));

  const categories = ledger == null ? null : categoriesOrDefaults(ledger.categories);
  const category = categories?.find((c) => c.id === id && c.parentId == null) ?? null;

  const header = isPage && (
    <header className={classes.pageHeader}>
      <BackButton onClick={back}>Plan</BackButton>
      {category != null && (
        <PageLink
          href="?settings=categories"
          push
          className={classes.quietButton}
        >
          Edit category
        </PageLink>
      )}
    </header>
  );

  if (categories == null || summary == null) {
    const couldnt = summary == null && failed;
    return (
      <Shell
        isPage={isPage}
        titleId={titleId}
      >
        {header}
        {couldnt || (ledger == null && ledgerFailed) ? (
          <div className={classes.failed}>
            <p className={classes.soft}>Couldn&apos;t load this month.</p>
            <Button
              variant="default"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        ) : (
          <Loading label="Loading this category">
            <Skeleton
              width="60%"
              height={28}
            />
            <Skeleton
              width="100%"
              height={150}
            />
          </Loading>
        )}
      </Shell>
    );
  }
  if (category == null) {
    return (
      <Shell
        isPage={isPage}
        titleId={titleId}
      >
        {header}
        <p
          id={titleId}
          className={classes.soft}
        >
          Category not found
        </p>
      </Shell>
    );
  }

  const isIncome = category.kind === 'income';
  const spending = rollUpEntries(
    isIncome ? summary.incomeByCategory : summary.spentByCategory,
    categories,
  ).find((top) => top.id === id);
  const cents = spending?.cents ?? 0;
  const entries = spending?.entries ?? 0;
  const year = trend.trend == null ? null : yearOf(trend.trend, categories, category);
  const usual = year == null ? null : againstAverage(year.map((m) => m.cents));
  const comparison = year == null ? null : yearComparison(year);
  const monthName = monthHeading(shown.month, { short: true });
  const line: BudgetLine | undefined = budgetLines(summary, categories).find((l) => l.id === id);
  const budget = summary.budgets?.find((b) => b.categoryId === id) ?? null;
  const budgetable = category.kind === 'expense' && !category.archived;
  const activity = activityAddress(id, shown.firstDay, shown.lastDay, shown.isCurrent);
  const dot = { '--dot': categoryColour(categories, id) } as CSSProperties;

  const seeLink =
    entries === 0 ? null : (
      <PageLink
        href={activity}
        className={isPage ? classes.wideQuiet : classes.quietButton}
      >
        {isPage
          ? entries === 1
            ? 'See it in Activity'
            : `See all ${entries} in Activity`
          : entries === 1
            ? 'See 1 entry'
            : `See ${entries} entries`}
      </PageLink>
    );

  const inside = spending != null && spending.subcategories.length > 0 && (
    <section
      aria-label={`Inside ${category.name}`}
      className={isPage ? `${classes.card} ${classes.inside}` : classes.insidePane}
    >
      <ul
        aria-label={`Inside ${category.name}`}
        className={classes.insideList}
      >
        {spending.subcategories.map((sub) => (
          <li
            key={sub.id}
            className={classes.insideRow}
          >
            <span className={classes.rowMain}>
              <span className={classes.insideName}>{sub.name}</span>
              {isPage && <span className={classes.rowSub}>{entriesText(sub.entries)}</span>}
            </span>
            <span className={`${classes.num} ${classes.insideAmount}`}>{amount(sub.cents)}</span>
          </li>
        ))}
        {spending.ownCents > 0 && (
          <li className={classes.insideRow}>
            <span className={classes.rowMain}>
              <span className={classes.insideName}>Just {category.name}</span>
              {isPage && (
                <span className={classes.rowSub}>
                  {entriesText(
                    spending.entries - spending.subcategories.reduce((n, s) => n + s.entries, 0),
                  )}
                </span>
              )}
            </span>
            <span className={`${classes.num} ${classes.insideAmount}`}>
              {amount(spending.ownCents)}
            </span>
          </li>
        )}
      </ul>
    </section>
  );

  const budgetLine = line != null && (
    <div className={isPage ? `${classes.card} ${classes.budgetCard}` : classes.budgetRead}>
      <div className={classes.budgetHead}>
        <span className={classes.budgetName}>Budget</span>
        <span className={classes.num}>
          {line.leftCents < 0
            ? `${money(-line.leftCents)} over ${amount(line.availableCents)}`
            : `${money(line.leftCents)} left of ${amount(line.availableCents)}`}
        </span>
      </div>
      <BudgetBar
        line={line}
        shown={shown}
      />
    </div>
  );

  return (
    <Shell
      isPage={isPage}
      titleId={titleId}
    >
      {header}
      {isPage ? (
        <div className={classes.categoryTop}>
          <h1
            id={titleId}
            className={classes.categoryTitle}
          >
            <span
              className={classes.bigDot}
              style={dot}
              aria-hidden
            />
            {category.name}
          </h1>
          <p className={`${classes.num} ${classes.bigFigure}`}>{money(cents)}</p>
          {usual != null && (
            <UsualLine
              against={usual}
              lead={`${isIncome ? 'Received' : 'Spent'} in ${monthName}`}
            />
          )}
        </div>
      ) : (
        <>
          <div className={classes.paneHead}>
            <h2
              id={titleId}
              className={classes.paneTitle}
            >
              <span
                className={classes.bigDot}
                style={dot}
                aria-hidden
              />
              {category.name}
            </h2>
            {seeLink}
          </div>
          <div className={classes.paneFigures}>
            <p className={`${classes.num} ${classes.paneFigure}`}>{money(cents)}</p>
            {usual != null && <UsualLine against={usual} />}
          </div>
        </>
      )}

      <section
        aria-label={`${category.name}, last 12 months${comparison != null ? `, ${comparison}` : ''}`}
        className={isPage ? `${classes.card} ${classes.year}` : classes.yearPane}
      >
        {year == null ? (
          trend.failed ? (
            <div className={classes.failed}>
              <p className={classes.soft}>Couldn&apos;t load the last 12 months.</p>
              <Button
                variant="default"
                size="xs"
                onClick={trend.retry}
              >
                Try again
              </Button>
            </div>
          ) : (
            <Loading label="Loading the last 12 months">
              <Skeleton
                width="100%"
                height={150}
              />
            </Loading>
          )
        ) : (
          <YearBars
            months={year}
            colour={categoryColour(categories, id)}
            labelled={isPage}
          />
        )}
      </section>

      {inside}

      {variant === 'pane' && shown.isCurrent && budgetable ? (
        <BudgetField
          categoryId={id}
          month={shown.current}
          budget={budget}
          focus={focusBudget}
        />
      ) : (
        budgetLine
      )}

      {isPage && seeLink}
    </Shell>
  );
}

/**
 * The month against the usual: on a page after what it is ("Spent in November ·"), with how
 * far off it is standing out; in a pane on its own
 */
export function UsualLine({ against, lead }: { against: AgainstAverage; lead?: string }) {
  const { currency } = useMoney();
  if (lead == null)
    return <p className={`${classes.soft} ${classes.usual}`}>{usualText(against, currency)}</p>;
  const { by, rest } = usualParts(against, currency);
  return (
    <p className={`${classes.soft} ${classes.usual}`}>
      {`${lead} · `}
      {by != null && (
        <>
          <strong className={classes.usualBy}>{by}</strong>{' '}
        </>
      )}
      {rest}
    </p>
  );
}

/** The page on a phone, or the pane beside the table on a computer */
export function Shell({
  isPage,
  titleId,
  children,
}: {
  isPage: boolean;
  titleId: string;
  children: ReactNode;
}) {
  return isPage ? (
    <div className={classes.categoryPage}>{children}</div>
  ) : (
    <aside
      aria-labelledby={titleId}
      className={`${classes.card} ${classes.pane}`}
    >
      {children}
    </aside>
  );
}

/**
 * The 12 months as bars, oldest first, each read out with its month and amount, the month
 * shown picked out in the category's colour; the average of the 11 before as a line
 */
export function YearBars({
  months,
  colour,
  labelled,
}: {
  months: MonthAmount[];
  colour: string;
  /** A page names the average on its line; a pane's line under the figure already does */
  labelled: boolean;
}) {
  const { money, amount } = useMoney();
  const largest = Math.max(0, ...months.map((m) => m.cents));
  const { averageCents } = againstAverage(months.map((m) => m.cents));
  // Heights for drawing only: the amounts stay in cents
  const height = (cents: number) => (largest > 0 ? (cents * 100) / largest : 0);
  return (
    <div
      className={classes.bars}
      data-labelled={labelled || undefined}
      style={{ '--dot': colour } as CSSProperties}
    >
      <div className={classes.barArea}>
        {largest > 0 && (
          <div
            className={classes.average}
            style={{ bottom: `${height(averageCents)}%` }}
            aria-hidden
          >
            {labelled && <span className={classes.averageText}>avg {amount(averageCents)}</span>}
          </div>
        )}
        <ul className={classes.barList}>
          {months.map((m, i) => {
            const isShown = i === months.length - 1;
            return (
              <li
                key={m.month}
                aria-current={isShown ? 'true' : undefined}
                className={classes.barItem}
              >
                <span
                  className={classes.barFill}
                  data-shown={isShown || undefined}
                  style={{ height: `${Math.max(height(m.cents), m.cents > 0 ? 2 : 0)}%` }}
                  aria-hidden
                />
                <span className="sr-only">{`${monthLabel(m.month)}, ${money(m.cents)}`}</span>
                <span
                  className={classes.barLetter}
                  data-shown={isShown || undefined}
                  aria-hidden
                >
                  {monthLabel(m.month).slice(0, 1)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {largest === 0 && labelled && <p className={classes.muted}>avg {amount(averageCents)}</p>}
    </div>
  );
}

/**
 * This month's budget for the category, changed in place: the amount is saved on Enter or
 * on leaving the field when it changed (emptied, it's taken away), Carry over at once. Each
 * goes through the ledger like every change, so it shows at once, works offline and is put
 * back if refused.
 */
function BudgetField({
  categoryId,
  month,
  budget,
  focus,
}: {
  categoryId: string;
  /** This month, as Plan names it, the budget's first */
  month: string;
  budget: MonthBudget | null;
  focus: { id: string } | null;
}) {
  const homeCurrency = useCurrency();
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  // A budget set where there was none carries over as "Carry over, for new budgets" says
  const carryForNew = useProfile().profile?.settings.carryOverDefault ?? false;
  const shownText = typed ?? (budget == null ? '' : budgetText(budget.amountCents, homeCurrency));

  useEffect(() => {
    if (focus != null) input.current?.focus();
  }, [focus]);

  const set = (amountCents: number | null, carryOver: boolean) =>
    change({
      op: 'setBudget',
      categoryId,
      fromMonth: month,
      amountCents,
      carryOver,
    });

  const save = () => {
    if (typed == null) return;
    const read = readBudget(typed);
    if ('error' in read) {
      setError(read.error);
      return;
    }
    setError(null);
    setTyped(null);
    // Left as it was: nothing to send
    if (read.cents === (budget?.amountCents ?? null)) return;
    set(read.cents, read.cents == null ? false : budget?.carryOver ?? carryForNew);
  };

  return (
    <form
      className={classes.budgetForm}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save();
      }}
    >
      <TextInput
        ref={input}
        label="Monthly budget"
        // "RM" 14px in from the edge, the amount 10px after it
        leftSection={<span className={classes.muted}>RM</span>}
        leftSectionWidth={47}
        classNames={{
          label: classes.budgetLabel,
          section: classes.budgetSection,
          input: classes.budgetInput,
        }}
        inputMode="decimal"
        placeholder="300"
        value={shownText}
        error={error}
        onChange={(e) => {
          setTyped(e.currentTarget.value);
          setError(null);
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          save();
        }}
      />
      <div className={classes.carry}>
        <span className={classes.carryText}>
          <span className={classes.carryName}>Carry over</span>
          <span
            id={hintId}
            className={`${classes.muted} ${classes.small}`}
          >
            Leftover rolls into next month
          </span>
        </span>
        <Switch
          aria-label="Carry over"
          aria-describedby={hintId}
          checked={budget?.carryOver ?? false}
          disabled={budget == null}
          onChange={(e) => {
            if (budget == null) return;
            set(budget.amountCents, e.currentTarget.checked);
          }}
        />
      </div>
    </form>
  );
}
