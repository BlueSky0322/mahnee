import { Button } from '@mantine/core';
import type { ReactNode } from 'react';
import { useId } from 'react';
import type { Category, Ledger, Recurring } from '@shared/api';
import { categoriesOrDefaults } from '@shared/categories';
import type { TransactionKind } from '@shared/ledger';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { monthlyCents } from '@shared/scheduled';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useMonths } from '../../ledger/month-start';
import { useMonthSummary, useWholeLedger } from '../../ledger/useLedger';
import { toDateInput } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';
import PageLink from '../home/PageLink';
import type { Opened, Prefill } from './ScheduleSheet';
import classes from './Scheduled.module.css';
import {
  cardNotes,
  itemTitle,
  nextText,
  phoneLine,
  running,
  signedAmount,
  waiting,
  whenText,
} from './scheduled-text';

// Plan › Scheduled (?plan=scheduled; R-Bills, R-Desk-Bills, R-Empty-Bills): every running
// scheduled item, as Expenses and Income (each with what it comes to in the person's
// month, a weekly item counted each time it falls in it) and Transfers ("not an expense"),
// in the order they were set up; a note for each card owed with no payment scheduled; and
// how many entries Scheduled added this month, with a link to them in Activity. Each item
// opens to change; with nothing scheduled, common ones to start from. Owner decision D8:
// each is added on its day by the server.

/** The common ones R-Empty-Bills offers, and what each starts with */
const COMMON: { label: string; kind: TransactionKind; category: string; payee: string | null }[] = [
  { label: 'Rent', kind: 'expense', category: 'Bills', payee: 'Rent' },
  { label: 'Salary', kind: 'income', category: 'Salary', payee: null },
  { label: 'Phone bill', kind: 'expense', category: 'Bills', payee: 'Phone bill' },
  { label: 'Netflix', kind: 'expense', category: 'Fun', payee: 'Netflix' },
  { label: 'Car loan', kind: 'expense', category: 'Transport', payee: 'Car loan' },
];

export default function ScheduledView({ onOpen }: { onOpen: (opened: Opened) => void }) {
  const { data: ledger } = useWholeLedger();
  const months = useMonths();
  const { summary } = useMonthSummary(months.current.month);
  const isDesktop = useIsDesktop() === true;
  if (ledger == null) return null;
  const categories = categoriesOrDefaults(ledger.categories);
  const items = (ledger.recurring ?? []).filter((r) => running(ledger, r));
  if (items.length === 0) {
    return (
      <Empty
        categories={categories}
        onOpen={onOpen}
      />
    );
  }
  const today = toDateInput(new Date());
  const period = summary ?? months.current;
  const added = (summary?.fromScheduled ?? []).reduce((all, s) => all + s.entries, 0);
  const of = (kind: TransactionKind) => items.filter((r) => r.kind === kind);
  const row = (r: Recurring) => (
    <Row
      key={r.id}
      item={r}
      ledger={ledger}
      categories={categories}
      today={today}
      isDesktop={isDesktop}
      onOpen={() => onOpen({ item: r })}
    />
  );
  return (
    <div className={classes.scheduled}>
      {(['expense', 'income'] as const).map(
        (kind) =>
          of(kind).length > 0 && (
            <Group
              key={kind}
              title={kind === 'expense' ? 'Expenses' : 'Income'}
              aside={`${formatMoney(monthlyCents(of(kind), period), DEFAULT_CURRENCY)} a month`}
            >
              {of(kind).map(row)}
            </Group>
          ),
      )}
      {of('transfer').length > 0 && (
        <Group
          title="Transfers"
          aside="not an expense"
        >
          {of('transfer').map(row)}
        </Group>
      )}
      {cardNotes(ledger, today).map(({ account, text }) => (
        <p
          key={account.id}
          className={classes.note}
        >
          {text}{' '}
          <a
            href="?plan=scheduled"
            className={classes.noteLink}
            onClick={(e) => {
              e.preventDefault();
              onOpen({ prefill: { kind: 'transfer', toAccountId: account.id } });
            }}
          >
            Schedule one
          </a>
        </p>
      ))}
      {added > 0 && (
        <PageLink
          href="?activity&scheduled"
          className={classes.added}
        >
          {`${added} added this month · `}
          <span className={classes.addedLink}>See them</span>
        </PageLink>
      )}
    </div>
  );
}

/** A group of items with its heading and what it comes to */
function Group({ title, aside, children }: { title: string; aside: string; children: ReactNode }) {
  const id = useId();
  return (
    <section
      className={classes.group}
      aria-labelledby={id}
    >
      <div className={classes.groupHead}>
        <h2
          id={id}
          className={classes.groupTitle}
        >
          {title}
        </h2>
        <span className={classes.groupAside}>{aside}</span>
      </div>
      <ul className={classes.rows}>{children}</ul>
    </section>
  );
}

/** One item: its tile, name and day, its next date and amount; it opens to change */
function Row({
  item: r,
  ledger,
  categories,
  today,
  isDesktop,
  onOpen,
}: {
  item: Recurring;
  ledger: Ledger;
  categories: Category[];
  today: string;
  isDesktop: boolean;
  onOpen: () => void;
}) {
  const title = itemTitle(r, ledger.accounts, categories, isDesktop);
  const letter = (r.payee ?? title).trim().charAt(0).toUpperCase();
  const amount = (
    <span
      className={`${classes.amount} sf-tabular`}
      data-kind={r.kind}
    >
      {signedAmount(r)}
    </span>
  );
  const changes = r.amountVaries === true;
  return (
    <li>
      <button
        type="button"
        className={classes.row}
        onClick={onOpen}
      >
        <span
          className={classes.tile}
          aria-hidden="true"
        >
          {letter}
        </span>
        <span className={classes.rowText}>
          <span className={classes.rowTitle}>{title}</span>
          <span className={classes.rowLine}>
            {isDesktop ? whenText(r, true) : phoneLine(r, ledger.accounts)}
          </span>
        </span>
        {isDesktop ? (
          <>
            <span className={classes.rowNext}>
              <span data-waiting={waiting(r, today) || undefined}>
                {nextText(r, today)}
                {changes && ' ·'}
              </span>
              {changes && <span className={classes.changes}>amount changes</span>}
            </span>
            {changes && <span className={classes.about}>about</span>}
            {amount}
          </>
        ) : (
          <span className={classes.rowEnd}>
            {amount}
            <span
              className={classes.rowLine}
              data-waiting={waiting(r, today) || undefined}
            >
              {nextText(r, today)}
            </span>
          </span>
        )}
      </button>
    </li>
  );
}

/** Nothing scheduled yet: what Scheduled does, and common ones to start from */
function Empty({
  categories,
  onOpen,
}: {
  categories: Category[];
  onOpen: (opened: Opened) => void;
}) {
  const start = (common: (typeof COMMON)[number]): Prefill => ({
    kind: common.kind,
    payee: common.payee,
    categoryId:
      categories.find((c) => c.name === common.category && c.parentId == null && !c.archived)?.id ??
      null,
  });
  return (
    <section className={classes.empty}>
      <h2 className={classes.emptyTitle}>Nothing scheduled</h2>
      <p className={classes.soft}>Rent, bills and pay, added on their day.</p>
      <Button onClick={() => onOpen({ prefill: {} })}>Schedule something</Button>
      <p className={classes.commonTitle}>Common ones</p>
      <div className={classes.chips}>
        {COMMON.map((common) => (
          <button
            key={common.label}
            type="button"
            className={classes.chip}
            onClick={() => onOpen({ prefill: start(common) })}
          >
            {common.label}
          </button>
        ))}
      </div>
    </section>
  );
}
