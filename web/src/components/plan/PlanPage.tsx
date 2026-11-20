import { Button } from '@mantine/core';
import { useMoney } from '../../hooks/useMoney';
import { BackIcon, ForwardIcon, PlanIcon, PlusIcon } from '../ui/icons';
import type { CSSProperties, ReactNode } from 'react';
import { useId, useState } from 'react';
import type { Category, Ledger, MonthSummary } from '@shared/api';
import { categoriesOrDefaults } from '@shared/categories';
import { FIRST_DAY } from '@shared/ledger';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { isAll, navigate } from '../../hooks/useRoute';
import type { BudgetLine } from '../../ledger/budgets';
import { budgetLines } from '../../ledger/budgets';
import type { CategorySpending } from '../../ledger/derive';
import { rollUpEntries } from '../../ledger/derive';
import { anyRepeating, nextPay } from '../../ledger/forecast';
import ScheduleSheet, { type Opened } from './ScheduleSheet';
import ScheduledView from './ScheduledView';
import { useMonthSummary, useWholeLedger } from '../../ledger/useLedger';
import { categoryColour } from '../../utils/category-colour';
import { addMonths, monthHeading, monthLabel } from '../../utils/date-input';
import PageLink from '../home/PageLink';
import { incomeLine } from '../home/home-text';
import { recurringName } from '../home/recurring-text';
import Skeleton, { Loading } from '../ui/Skeleton';
import BudgetBar from './BudgetBar';
import CategoryView from './CategoryView';
import classes from './Plan.module.css';
import TotalView from './TotalView';
import { planAddress } from './plan-address';
import { type PlanMonth, planMonth } from './plan-month';
import { useMonths } from '../../ledger/month-start';
import { budgetWords, deskSubtitle, phoneSubtitle, shareLabel } from './plan-text';

/** The earliest month a transaction can be in */
const FIRST_MONTH = FIRST_DAY.slice(0, 7);

// Plan (?plan): the month's budgets with a marker for how much of it has gone, where the spending
// went with each category's share, and what came in by category. On a phone each category opens a
// page of its own over 12 months (?plan&category=<id>); on a computer, a table of every spending
// category, with the one chosen open on the right, its budget changed there. Every expense and all
// income over 12 months (Home's cards open them, ?plan&category=expenses or income) open the same
// way. The arrows step back a month at a time, never past this one (?plan&month=2026-10). Scheduled
// (?plan=scheduled) is Plan's other half: every scheduled item (ScheduledView), with Schedule (a
// phone) or Schedule something (a computer) to set one up.
export default function PlanPage({
  month,
  half,
  category,
}: {
  month: string | null;
  half: 'budgets' | 'scheduled';
  category: string | null;
}) {
  const isDesktop = useIsDesktop() === true;
  const shown = planMonth(month, useMonths());
  const [opened, setOpened] = useState<Opened>(null);
  const { data: ledger } = useWholeLedger();
  if (half === 'budgets' && category != null && !isDesktop) {
    return (
      <div className={classes.page}>
        <Opened
          id={category}
          shown={shown}
          variant="page"
        />
      </div>
    );
  }
  return (
    <div
      className={isDesktop ? `${classes.page} ${classes.desktop}` : classes.page}
      data-half={half}
    >
      <Header
        shown={shown}
        half={half}
        category={category}
        isDesktop={isDesktop}
        scheduling={
          half !== 'scheduled' || ledger == null
            ? null
            : { any: anyRepeating(ledger), open: () => setOpened({ prefill: {} }) }
        }
      />
      {half === 'scheduled' ? (
        <>
          <ScheduledView onOpen={setOpened} />
          <ScheduleSheet
            opened={opened}
            onClose={() => setOpened(null)}
          />
        </>
      ) : (
        <Budgets
          shown={shown}
          category={category}
          isDesktop={isDesktop}
        />
      )}
    </div>
  );
}

/** A category over 12 months, or every expense or all income */
function Opened({
  id,
  shown,
  variant,
  focusBudget = null,
}: {
  id: string;
  shown: PlanMonth;
  variant: 'page' | 'pane';
  focusBudget?: { id: string } | null;
}) {
  return isAll(id) ? (
    <TotalView
      which={id}
      shown={shown}
      variant={variant}
    />
  ) : (
    <CategoryView
      id={id}
      shown={shown}
      variant={variant}
      focusBudget={focusBudget}
    />
  );
}

/** "Plan", the month and its arrows, and the Budgets / Scheduled halves */
function Header({
  shown,
  half,
  category,
  isDesktop,
  scheduling,
}: {
  shown: PlanMonth;
  half: 'budgets' | 'scheduled';
  category: string | null;
  isDesktop: boolean;
  /** On Scheduled: whether anything is, and setting a new one up */
  scheduling: { any: boolean; open: () => void } | null;
}) {
  // Each month is its own address, so Back returns; a computer keeps the category open
  const step = (to: string) =>
    navigate(
      planAddress({
        month: to >= shown.current ? null : to,
        category: isDesktop ? category : null,
      }),
    );
  const arrows = half === 'budgets' && (
    <div className={classes.monthNav}>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="Previous month"
        disabled={shown.month <= FIRST_MONTH}
        onClick={() => step(addMonths(shown.month, -1))}
      >
        <BackIcon size={20} />
      </button>
      <span className={classes.monthName}>
        {isDesktop
          ? `${monthHeading(shown.month)}${shown.isCurrent ? ` · day ${shown.at.day} of ${shown.at.days}` : ''}`
          : monthLabel(shown.month)}
      </span>
      <button
        type="button"
        className={classes.iconButton}
        aria-label="Next month"
        disabled={shown.isCurrent}
        onClick={() => step(addMonths(shown.month, 1))}
      >
        <ForwardIcon size={20} />
      </button>
    </div>
  );
  const halves = (
    <nav
      aria-label="Plan"
      className={classes.halves}
    >
      <PageLink
        href="?plan"
        aria-current={half === 'budgets' ? 'page' : undefined}
      >
        Budgets
      </PageLink>
      <PageLink
        href="?plan=scheduled"
        aria-current={half === 'scheduled' ? 'page' : undefined}
      >
        Scheduled
      </PageLink>
    </nav>
  );
  // Schedule something on a computer (outlined while nothing is, beside the one in the
  // page); Schedule on a phone once something is, and the month while nothing is
  let schedule: ReactNode = null;
  if (scheduling != null && (isDesktop || scheduling.any)) {
    schedule = (
      <Button
        variant={isDesktop ? (scheduling.any ? 'filled' : 'default') : 'light'}
        size="xs"
        className={isDesktop ? classes.small : `${classes.small} ${classes.asLink}`}
        leftSection={isDesktop ? undefined : <PlusIcon size={16} />}
        onClick={scheduling.open}
      >
        {isDesktop ? 'Schedule something' : 'Schedule'}
      </Button>
    );
  } else if (scheduling != null) {
    schedule = <span className={classes.monthQuiet}>{monthLabel(shown.month)}</span>;
  }
  if (isDesktop) {
    return (
      <header className={classes.header}>
        <div className={classes.headerStart}>
          <h1 className={classes.title}>Plan</h1>
          {halves}
        </div>
        {arrows}
        {schedule}
      </header>
    );
  }
  return (
    <>
      <header className={classes.header}>
        <h1 className={classes.title}>Plan</h1>
        {arrows}
        {schedule}
      </header>
      {halves}
    </>
  );
}

/** What Plan works out from the month's totals and the ledger */
interface Month {
  summary: MonthSummary;
  categories: Category[];
  ledger: Ledger;
  lines: BudgetLine[];
  rows: CategorySpending[];
}

function Budgets({
  shown,
  category,
  isDesktop,
}: {
  shown: PlanMonth;
  category: string | null;
  isDesktop: boolean;
}) {
  const { summary, failed, retry } = useMonthSummary(shown.month);
  const { data: ledger } = useWholeLedger();
  const [focusing, setFocusing] = useState<{ id: string } | null>(null);

  if (summary == null || ledger == null) {
    if (failed) {
      return (
        <div className={`${classes.card} ${classes.failed}`}>
          <p className={classes.soft}>Couldn&apos;t load this month.</p>
          <Button
            variant="default"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      );
    }
    return (
      <Loading
        label="Loading this month"
        className={classes.loading}
      >
        <Skeleton
          width="100%"
          height={isDesktop ? 360 : 220}
        />
        <Skeleton
          width="100%"
          height={isDesktop ? 96 : 320}
        />
      </Loading>
    );
  }
  const categories = categoriesOrDefaults(ledger.categories);
  const data: Month = {
    summary,
    categories,
    ledger,
    lines: budgetLines(summary, categories),
    rows: rollUpEntries(summary.spentByCategory, categories),
  };

  const nothing = data.lines.length === 0 && summary.spentCents === 0;
  if (!isDesktop || nothing) {
    const cards = (
      <>
        <PhoneBudgets
          data={data}
          shown={shown}
        />
        <WhereItWent
          data={data}
          shown={shown}
        />
        <Income
          data={data}
          shown={shown}
          isDesktop={false}
          open={null}
          quiet={nothing}
        />
      </>
    );
    if (!isDesktop) return cards;
    // A computer with nothing this month: No budgets yet beside the two small cards
    if (category == null && shown.isCurrent && data.lines.length === 0) {
      return (
        <div className={classes.emptyGrid}>
          <PhoneBudgets
            data={data}
            shown={shown}
          />
          <div className={classes.emptySide}>
            <WhereItWent
              data={data}
              shown={shown}
            />
            <Income
              data={data}
              shown={shown}
              isDesktop={false}
              open={null}
              quiet
            />
          </div>
        </div>
      );
    }
    if (category == null) return cards;
    // Asked for a category, it opens beside the cards
    return (
      <div className={classes.split}>
        <div className={classes.mainColumn}>{cards}</div>
        <Opened
          key={category}
          id={category}
          shown={shown}
          variant="pane"
        />
      </div>
    );
  }

  const tableRows = deskRows(data);
  const open = category ?? tableRows[0]?.id ?? null;
  return (
    <div className={classes.split}>
      <div className={classes.mainColumn}>
        <ExpensesTable
          data={data}
          rows={tableRows}
          shown={shown}
          open={open}
          onOpen={(id, focus) => {
            navigate(planAddress({ month: shown.isCurrent ? null : shown.month, category: id }), {
              replace: true,
            });
            setFocusing(focus ? { id } : null);
          }}
        />
        <Income
          data={data}
          shown={shown}
          isDesktop
          open={open}
        />
      </div>
      {open != null && (
        <Opened
          // A fresh pane for each category, so what's typed in one never shows in another
          key={open}
          id={open}
          shown={shown}
          variant="pane"
          focusBudget={focusing?.id === open ? focusing : null}
        />
      )}
    </div>
  );
}

/** A phone's budgets: each with what's left and a bar against the month; none says so */
function PhoneBudgets({ data, shown }: { data: Month; shown: PlanMonth }) {
  const { money, currency } = useMoney();
  const titleId = useId();
  if (data.lines.length === 0) {
    // A month gone by can't be given a budget now
    if (!shown.isCurrent) return null;
    return (
      <section
        aria-label="Budgets"
        className={`${classes.card} ${classes.empty}`}
      >
        <span
          className={classes.emptyIcon}
          aria-hidden
        >
          <PlanIcon size={24} />
        </span>
        <h2 className={classes.emptyTitle}>No budgets yet</h2>
        <p className={classes.soft}>
          A monthly amount per category, with a bar for what&apos;s left.
        </p>
        <PageLink
          href="?settings=categories&budget"
          push
          className={classes.primaryLink}
        >
          Set a budget
        </PageLink>
      </section>
    );
  }
  return (
    <section
      aria-labelledby={titleId}
      className={`${classes.card} ${classes.budgets}`}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Budgets
          {shown.isCurrent && (
            <span className={classes.headNote}>
              {' '}
              Day {shown.at.day} of {shown.at.days}
            </span>
          )}
        </h2>
        {shown.isCurrent && (
          <PageLink
            href="?settings=categories"
            push
            className={classes.more}
          >
            <PlusIcon
              size={14}
              aria-hidden
            />
            Budget
          </PageLink>
        )}
      </div>
      <ul className={classes.budgetList}>
        {data.lines.map((line) => {
          const words = budgetWords(line, shown.at, { short: false, currency });
          const tone =
            words.pace === 'over' ? classes.neg : words.pace === 'faster' ? classes.due : '';
          const carryOver = data.summary.budgets?.find((b) => b.categoryId === line.id)?.carryOver;
          const carried =
            line.carriedCents !== 0
              ? `incl. ${line.carriedCents < 0 ? '−' : ''}${money(Math.abs(line.carriedCents))} carried over`
              : carryOver
                ? 'Carry over on'
                : null;
          return (
            <li
              key={line.id}
              className={classes.budget}
            >
              <div className={classes.budgetHead}>
                <span className={classes.budgetName}>{line.name}</span>
                <span className={`${classes.num} ${tone}`}>
                  {words.left.replace(/ (left|over)$/, '')}{' '}
                  <span className={tone === '' ? classes.muted : ''}>
                    {words.left.endsWith(' over') ? 'over' : 'left'}
                  </span>
                </span>
              </div>
              <BudgetBar
                line={line}
                shown={shown}
              />
              <div className={`${classes.budgetMeta} ${tone || classes.muted}`}>
                <span>{words.meta}</span>
                {carried != null && <span>{carried}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Where the month's spending went: its total, a share bar and a row for each category */
function WhereItWent({ data, shown }: { data: Month; shown: PlanMonth }) {
  const { money, amount, currency } = useMoney();
  const titleId = useId();
  const total = data.summary.spentCents;
  const name = monthHeading(shown.month, { short: true });
  return (
    <section
      aria-labelledby={titleId}
      className={`${classes.card} ${classes.went}`}
      data-empty={total === 0 || undefined}
    >
      <div className={classes.wentHead}>
        <div className={classes.cardHead}>
          <h2
            id={titleId}
            className={classes.cardTitle}
          >
            Where it went
          </h2>
          <span className={`${classes.num} ${classes.headFigure}`}>{money(total)}</span>
        </div>
        {total === 0 ? (
          <p
            className={classes.soft}
          >{`Nothing spent in ${name}${shown.isCurrent ? ' yet' : ''}.`}</p>
        ) : (
          <div
            role="img"
            aria-label={shareLabel(data.rows, total)}
            className={classes.share}
          >
            {data.rows.map((row) => (
              <span
                key={row.id}
                style={{
                  // A share of the bar's width, for drawing only: the amounts stay in cents
                  width: `${(row.cents * 100) / total}%`,
                  background: categoryColour(data.categories, row.id),
                }}
              />
            ))}
          </div>
        )}
      </div>
      {total > 0 && (
        <ul className={classes.rows}>
          {data.rows.map((row) => {
            const known = data.categories.some((c) => c.id === row.id && c.parentId == null);
            const content = (
              <>
                <span
                  className={classes.dot}
                  style={{ '--dot': categoryColour(data.categories, row.id) } as CSSProperties}
                  aria-hidden
                />
                <span className={classes.rowMain}>
                  <span className={classes.rowTitle}>{row.name}</span>
                  <span className={classes.rowSub}>{phoneSubtitle(row, total, currency)}</span>
                </span>
                <span className={`${classes.num} ${classes.rowAmount}`}>{amount(row.cents)}</span>
              </>
            );
            return (
              <li key={row.id}>
                {known ? (
                  <PageLink
                    href={planAddress({
                      month: shown.isCurrent ? null : shown.month,
                      category: row.id,
                    })}
                    // A page of its own under Plan: Back returns
                    push
                    className={classes.row}
                  >
                    {content}
                  </PageLink>
                ) : (
                  <div className={classes.row}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What came in this month, and when the next pay is due; then what came in by category,
 * largest first, each opening its own 12 months (a page on a phone, beside the table on a
 * computer, where `open` is the one open)
 */
function Income({
  data,
  shown,
  isDesktop,
  open,
  quiet = false,
}: {
  data: Month;
  shown: PlanMonth;
  isDesktop: boolean;
  open: string | null;
  /** Nothing this month at all: drawn a little closer */
  quiet?: boolean;
}) {
  const { money, amount, currency } = useMoney();
  const titleId = useId();
  const rows = rollUpEntries(data.summary.incomeByCategory, data.categories);
  const pay = nextPay(data.ledger);
  const received = data.summary.incomeCents;
  let line: ReactNode = null;
  if (shown.isCurrent) {
    line =
      pay != null ? (
        incomeLine({ name: recurringName(pay.recurring, data.categories), date: pay.due })
      ) : (
        <>
          {received === 0 && 'Nothing in yet. '}
          <PageLink
            href="?plan=scheduled"
            className={classes.inlineLink}
          >
            Schedule your pay
          </PageLink>
        </>
      );
  }
  return (
    <section
      aria-labelledby={titleId}
      className={`${classes.card} ${isDesktop ? classes.incomeDesk : classes.income}`}
      data-quiet={quiet || undefined}
    >
      <div className={classes.incomeText}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Income
        </h2>
        {isDesktop && line != null && <p className={classes.soft}>{line}</p>}
      </div>
      <span className={`${classes.num} ${classes.headFigure}`}>{money(received)}</span>
      {!isDesktop && line != null && <p className={classes.soft}>{line}</p>}
      {rows.length > 0 && (
        <ul
          aria-label="Income by category"
          className={`${classes.rows} ${classes.incomeRows}`}
        >
          {rows.map((row) => {
            const known = data.categories.some((c) => c.id === row.id && c.parentId == null);
            const content = (
              <>
                <span
                  className={classes.dot}
                  style={{ '--dot': categoryColour(data.categories, row.id) } as CSSProperties}
                  aria-hidden
                />
                <span className={classes.rowMain}>
                  <span className={classes.rowTitle}>{row.name}</span>
                  <span className={classes.rowSub}>{phoneSubtitle(row, received, currency)}</span>
                </span>
                <span className={`${classes.num} ${classes.rowAmount}`}>{amount(row.cents)}</span>
              </>
            );
            return (
              <li key={row.id}>
                {known ? (
                  <PageLink
                    href={planAddress({
                      month: shown.isCurrent ? null : shown.month,
                      category: row.id,
                    })}
                    // A page of its own on a phone, so Back returns; beside the table on a
                    // computer, in this page's place
                    push={!isDesktop}
                    aria-current={isDesktop && row.id === open ? 'true' : undefined}
                    className={classes.row}
                  >
                    {content}
                  </PageLink>
                ) : (
                  <div className={classes.row}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A row of the computer's table: a category with its spending, or with none this month */
interface DeskRow {
  id: string;
  name: string;
  spending: CategorySpending | null;
  /** Whether a budget can be set on it: a listed top-level spending category */
  budgetable: boolean;
}

/**
 * Every category the month spent in, largest first, then the listed top-level spending
 * categories with nothing in it, in their order
 */
function deskRows({ rows, categories }: Month): DeskRow[] {
  const budgetable = (id: string) =>
    categories.some(
      (c) => c.id === id && c.parentId == null && c.kind === 'expense' && !c.archived,
    );
  const spent: DeskRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    spending: row,
    budgetable: budgetable(row.id),
  }));
  const rest = categories
    .filter(
      (c) =>
        c.kind === 'expense' &&
        c.parentId == null &&
        !c.archived &&
        !rows.some((r) => r.id === c.id),
    )
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .map((c) => ({ id: c.id, name: c.name, spending: null, budgetable: true }));
  return [...spent, ...rest];
}

/** The computer's table of every spending category, with its budget and what's left */
function ExpensesTable({
  data,
  rows,
  shown,
  open,
  onOpen,
}: {
  data: Month;
  rows: DeskRow[];
  shown: PlanMonth;
  open: string | null;
  onOpen: (id: string, focusBudget: boolean) => void;
}) {
  const { money, amount, currency } = useMoney();
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={`${classes.card} ${classes.tableCard}`}
    >
      <div className={classes.tableHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Expenses by category
        </h2>
        <span className={classes.tableHeadEnd}>
          <span className={`${classes.num} ${classes.soft}`}>
            {money(data.summary.spentCents)} spent
          </span>
          <PageLink
            href="?settings=categories"
            push
            className={classes.more}
          >
            Edit categories
          </PageLink>
        </span>
      </div>
      <table
        aria-label="Expenses by category"
        className={classes.table}
      >
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th
              scope="col"
              className={classes.end}
            >
              Spent
            </th>
            <th scope="col">Budget, with today marked</th>
            <th
              scope="col"
              className={classes.end}
            >
              Left
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const line = data.lines.find((l) => l.id === row.id);
            const carriesOver =
              line != null &&
              (data.summary.budgets?.find((b) => b.categoryId === row.id)?.carryOver ?? false);
            const words =
              line == null ? null : budgetWords(line, shown.at, { short: true, currency });
            const tone =
              words?.pace === 'over' ? classes.neg : words?.pace === 'faster' ? classes.due : '';
            return (
              <tr
                key={row.id}
                data-open={row.id === open || undefined}
              >
                <td>
                  <button
                    type="button"
                    className={classes.rowButton}
                    aria-current={row.id === open ? 'true' : undefined}
                    onClick={() => onOpen(row.id, false)}
                  >
                    <span
                      className={classes.dot}
                      style={{ '--dot': categoryColour(data.categories, row.id) } as CSSProperties}
                      aria-hidden
                    />
                    {row.name}
                  </button>
                  <span className={classes.rowSubDesk}>
                    {deskSubtitle(row.spending, {
                      carriesOver,
                      month: shown.month,
                      isCurrent: shown.isCurrent,
                    })}
                  </span>
                </td>
                <td className={`${classes.end} ${classes.num}`}>
                  {amount(row.spending?.cents ?? 0)}
                </td>
                <td>
                  {line != null ? (
                    <BudgetBar
                      line={line}
                      shown={shown}
                    />
                  ) : (
                    shown.isCurrent &&
                    row.budgetable && (
                      <button
                        type="button"
                        className={classes.setBudget}
                        onClick={() => onOpen(row.id, true)}
                      >
                        Set a budget
                      </button>
                    )
                  )}
                </td>
                <td className={`${classes.end} ${classes.num}`}>
                  {words != null && <span className={tone}>{words.left}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
