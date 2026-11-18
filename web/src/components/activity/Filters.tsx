import { Button, TextInput } from '@mantine/core';
import { DownIcon } from '../ui/icons';
import { useState } from 'react';
import type { TransactionKind } from '@shared/ledger';
import { periodMonthOf, shiftMonth } from '@shared/period';
import { useMonthStart } from '../../ledger/month-start';
import { useAccounts, useCategories } from '../../ledger/useLedger';
import { categoryName } from '../common/category-name';
import Chip from '../ui/Chip';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { kindText, periodText } from './activity-text';
import type { Days, Filters } from './address';
import { dayRange, isDefaultKinds, monthDays } from './address';
import classes from './Activity.module.css';

type Which = 'account' | 'category' | 'days' | 'kind';

const TITLES: Record<Which, string> = {
  account: 'Account',
  category: 'Category',
  days: 'When',
  kind: 'Kind',
};

const KINDS: { label: string; kinds: TransactionKind[] | null }[] = [
  { label: 'Expenses and income', kinds: ['expense', 'income'] },
  { label: 'Expenses', kinds: ['expense'] },
  { label: 'Income', kinds: ['income'] },
  { label: 'Transfers', kinds: ['transfer'] },
  { label: 'All kinds', kinds: null },
];

/** Whether the days are exactly the person's month `month`, from `start` */
const isMonth = (days: Days, month: string, start: number) => {
  if (days.kind !== 'range') return false;
  const { from, to } = monthDays(month, start);
  return days.from === from && days.to === to;
};

// Activity's four chips (R-Activity): the account, the category, the days and the kind,
// each naming what it's set to and drawn pressed when it isn't at its default; and, when
// only what Scheduled added is shown, "From Scheduled", which takes that off. A chip opens
// its list (a sheet on phones, a dialog elsewhere); picking one sets it, in the address.
// While a phone is selecting, only the chips that are set show (R-Activity-Select).
export default function FilterChips({
  filters,
  today,
  onlySet,
  carets,
  onChange,
}: {
  filters: Filters;
  today: string;
  onlySet: boolean;
  /** A phone's chips say they open a list (the kind's doesn't, as drawn) */
  carets: boolean;
  onChange: (next: Partial<Filters>) => void;
}) {
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const start = useMonthStart();
  const [open, setOpen] = useState<Which | null>(null);
  const [shownList, setShownList] = useState<Which>('account');
  if (open != null && open !== shownList) setShownList(open);

  const account = accounts?.find((a) => a.id === filters.account);
  const chips: { which: Which; label: string; on: boolean }[] = [
    { which: 'account', label: account?.name ?? 'All accounts', on: filters.account != null },
    {
      which: 'category',
      label:
        filters.category == null
          ? 'All categories'
          : categoryName(categories ?? [], filters.category),
      on: filters.category != null,
    },
    {
      which: 'days',
      label: periodText(dayRange(filters.days, today, start), today, start),
      on: filters.days.kind !== 'month',
    },
    { which: 'kind', label: kindText(filters.kinds), on: !isDefaultKinds(filters.kinds) },
  ];
  const set = (next: Partial<Filters>) => {
    onChange(next);
    setOpen(null);
  };

  return (
    <>
      {chips
        .filter((chip) => !onlySet || chip.on)
        .map((chip) => (
          <Chip
            key={chip.which}
            on={chip.on}
            opens
            onClick={() => setOpen(chip.which)}
          >
            {chip.label}
            {carets && chip.which !== 'kind' && (
              <DownIcon
                size={14}
                aria-hidden
              />
            )}
          </Chip>
        ))}
      {filters.scheduled && (
        // Only what Scheduled added; tapping it takes it off
        <Chip
          on
          onClick={() => onChange({ scheduled: false })}
        >
          From Scheduled
        </Chip>
      )}
      <ResponsiveDialog
        opened={open != null}
        onClose={() => setOpen(null)}
        title={TITLES[shownList]}
      >
        {shownList === 'account' && (
          <Choices
            choices={[
              {
                label: 'All accounts',
                on: filters.account == null,
                pick: () => set({ account: null }),
              },
              ...(accounts ?? []).map((a) => ({
                label: a.archived ? `${a.name} (archived)` : a.name,
                on: filters.account === a.id,
                pick: () => set({ account: a.id }),
              })),
            ]}
          />
        )}
        {shownList === 'category' && (
          <CategoryChoices
            current={filters.category}
            onPick={(category) => set({ category })}
          />
        )}
        {shownList === 'kind' && (
          <Choices
            choices={KINDS.map(({ label, kinds }) => ({
              label,
              on: kindText(filters.kinds) === label,
              pick: () => set({ kinds }),
            }))}
          />
        )}
        {shownList === 'days' && (
          <DayChoices
            days={filters.days}
            today={today}
            onPick={(days) => set({ days })}
          />
        )}
      </ResponsiveDialog>
    </>
  );
}

function Choices({ choices }: { choices: { label: string; on: boolean; pick: () => void }[] }) {
  return (
    <div
      className={classes.choices}
      role="radiogroup"
    >
      {choices.map((c) => (
        <label
          key={c.label}
          className={classes.choice}
        >
          <input
            type="radio"
            name="choice"
            checked={c.on}
            onChange={c.pick}
            onClick={c.on ? c.pick : undefined}
          />
          {c.label}
        </label>
      ))}
    </div>
  );
}

function CategoryChoices({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (id: string | null) => void;
}) {
  const { categories, tree } = useCategories();
  const all = categories ?? [];
  const listed = tree == null ? [] : [...tree.listed.expense, ...tree.listed.income];
  const options = listed.flatMap((node) => [
    { id: node.id, label: node.name },
    ...node.subcategories.map((c) => ({ id: c.id, label: `${node.name} › ${c.name}` })),
  ]);
  // One no longer listed (archived) still shows while it's the filter
  if (current != null && !options.some((o) => o.id === current)) {
    options.push({ id: current, label: categoryName(all, current) });
  }
  return (
    <Choices
      choices={[
        { label: 'All categories', on: current == null, pick: () => onPick(null) },
        ...options.map((o) => ({ label: o.label, on: current === o.id, pick: () => onPick(o.id) })),
      ]}
    />
  );
}

function DayChoices({
  days,
  today,
  onPick,
}: {
  days: Days;
  today: string;
  onPick: (days: Days) => void;
}) {
  // The person's months (shared/period.ts)
  const start = useMonthStart();
  const last = shiftMonth(periodMonthOf(today, start), -1);
  const lastMonth = monthDays(last, start);
  const picking = days.kind === 'day' || (days.kind === 'range' && !isMonth(days, last, start));
  const [own, setOwn] = useState(picking);
  const range = dayRange(days, today, start);
  const [from, setFrom] = useState(
    days.kind === 'month' || days.kind === 'all' ? '' : range.from ?? '',
  );
  const [to, setTo] = useState(days.kind === 'month' || days.kind === 'all' ? '' : range.to ?? '');
  return (
    <>
      <Choices
        choices={[
          {
            label: 'This month',
            on: !own && days.kind === 'month',
            pick: () => onPick({ kind: 'month' }),
          },
          {
            label: 'Last month',
            on: !own && isMonth(days, last, start),
            pick: () => onPick({ kind: 'range', ...lastMonth }),
          },
          {
            label: 'All months',
            on: !own && days.kind === 'all',
            pick: () => onPick({ kind: 'all' }),
          },
          { label: 'Pick dates', on: own, pick: () => setOwn(true) },
        ]}
      />
      {own && (
        <form
          className={classes.pickDates}
          onSubmit={(e) => {
            e.preventDefault();
            if (from === '' && to === '') return;
            onPick({ kind: 'range', from: from || null, to: to || null });
          }}
        >
          <TextInput
            type="date"
            label="From"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
          <TextInput
            type="date"
            label="To"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.currentTarget.value)}
          />
          <Button
            type="submit"
            disabled={from === '' && to === ''}
          >
            Show these dates
          </Button>
        </form>
      )}
    </>
  );
}
