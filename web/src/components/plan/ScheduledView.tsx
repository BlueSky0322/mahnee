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
import EntryTile from '../common/EntryTile';
import PageLink from '../home/PageLink';
import { AlertIcon, ForwardIcon, ScheduledIcon } from '../ui/icons';
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
        isDesktop={isDesktop}
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
  const groups = (
    <>
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
    </>
  );
  const aside = (
    <>
      {cardNotes(ledger, today).map(({ account, owed, by }) => (
        <div
          key={account.id}
          role="note"
          className={classes.note}
        >
          <AlertIcon
            size={16}
            className={classes.noteIcon}
            aria-hidden
          />
          <span>
            <b className={classes.noteName}>{account.name}</b>
            {': '}
            <span className="sf-tabular">{owed}</span>
            {` owed${by == null ? '' : ` by ${by}`}, no payment scheduled. `}
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
          </span>
        </div>
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
    </>
  );
  // A computer: every group in one card, the notes in a column beside it
  if (isDesktop) {
    return (
      <div className={classes.desk}>
        <div className={classes.deskCard}>{groups}</div>
        <div className={classes.side}>{aside}</div>
      </div>
    );
  }
  return (
    <div className={classes.scheduled}>
      {groups}
      {aside}
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
  const changes = r.amountVaries === true;
  const amount = (
    <span
      className={`${classes.amount} sf-tabular`}
      data-kind={r.kind}
    >
      {isDesktop && changes && <span className={classes.about}>about </span>}
      {signedAmount(r)}
    </span>
  );
  // The item's category letter in its colour, or a transfer's arrows
  const tile = (
    <EntryTile
      t={r}
      categories={categories}
    />
  );
  if (isDesktop) {
    return (
      <li>
        <button
          type="button"
          className={classes.deskRow}
          onClick={onOpen}
        >
          {tile}
          <span className={classes.deskName}>{title}</span>
          <span className={classes.deskWhen}>{whenText(r, true)}</span>
          <span className={classes.rowNext}>
            <span data-waiting={waiting(r, today) || undefined}>
              {nextText(r, today)}
              {changes && ' · '}
            </span>
            {changes && <span className={classes.changes}>amount changes</span>}
          </span>
          {amount}
          <ForwardIcon
            size={16}
            className={classes.chevron}
            aria-hidden
          />
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={classes.row}
        onClick={onOpen}
      >
        {tile}
        <span className={classes.rowText}>
          <span className={classes.rowTitle}>{title}</span>
          <span
            className={classes.rowLine}
            data-changes={changes || undefined}
          >
            {phoneLine(r, ledger.accounts)}
          </span>
        </span>
        <span className={classes.rowEnd}>
          {amount}
          <span
            className={classes.rowNextPhone}
            data-waiting={waiting(r, today) || undefined}
          >
            {nextText(r, today)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Nothing scheduled yet: what Scheduled does, and common ones to start from */
function Empty({
  categories,
  isDesktop,
  onOpen,
}: {
  categories: Category[];
  isDesktop: boolean;
  onOpen: (opened: Opened) => void;
}) {
  const start = (common: (typeof COMMON)[number]): Prefill => ({
    kind: common.kind,
    payee: common.payee,
    categoryId:
      categories.find((c) => c.name === common.category && c.parentId == null && !c.archived)?.id ??
      null,
  });
  const common = (
    <div className={classes.common}>
      <p className={classes.commonTitle}>Common ones</p>
      <div className={classes.chips}>
        {COMMON.map((c) => (
          <button
            key={c.label}
            type="button"
            className={classes.chip}
            onClick={() => onOpen({ prefill: start(c) })}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
  // A phone: the message on the page, common ones under it; a computer: both in one card
  return (
    <section
      aria-label="Scheduled"
      className={isDesktop ? classes.emptyCard : classes.emptyPage}
    >
      <div className={classes.empty}>
        <span
          className={classes.emptyIcon}
          aria-hidden
        >
          <ScheduledIcon size={24} />
        </span>
        <h2 className={classes.emptyTitle}>Nothing scheduled</h2>
        <p className={classes.soft}>Rent, bills and pay, added on their day.</p>
        <Button
          className={classes.emptyAction}
          onClick={() => onOpen({ prefill: {} })}
        >
          Schedule something
        </Button>
      </div>
      {common}
    </section>
  );
}
