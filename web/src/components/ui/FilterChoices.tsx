import { Button, TextInput } from '@mantine/core';
import { useId } from 'react';
import classes from './FilterChoices.module.css';

/** Picking the checked option again also confirms the choice. */
export function FilterChoices({
  choices,
}: {
  choices: readonly { label: string; on: boolean; pick: () => void }[];
}) {
  const name = useId();
  return (
    <div
      className={classes.choices}
      role="radiogroup"
    >
      {choices.map((choice) => (
        <label
          key={choice.label}
          className={classes.choice}
        >
          <input
            type="radio"
            name={name}
            checked={choice.on}
            onChange={choice.pick}
            onClick={choice.on ? choice.pick : undefined}
          />
          {choice.label}
        </label>
      ))}
    </div>
  );
}

export interface DateRange {
  from: string | null;
  to: string | null;
}

/** Either end can be left open when filtering by date. */
export function DateRangeForm({
  value,
  onChange,
  onApply,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  onApply: (range: DateRange) => void;
}) {
  const { from, to } = value;
  const empty = from == null && to == null;
  return (
    <form
      className={classes.pickDates}
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onApply(value);
      }}
    >
      <TextInput
        type="date"
        label="From"
        value={from ?? ''}
        max={to ?? undefined}
        onChange={(event) => onChange({ from: event.currentTarget.value || null, to })}
      />
      <TextInput
        type="date"
        label="To"
        value={to ?? ''}
        min={from ?? undefined}
        onChange={(event) => onChange({ from, to: event.currentTarget.value || null })}
      />
      <Button
        type="submit"
        disabled={empty}
      >
        Show these dates
      </Button>
    </form>
  );
}
