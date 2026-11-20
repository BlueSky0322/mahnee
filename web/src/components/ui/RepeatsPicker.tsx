import type { KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Schedule } from '@shared/recurring';
import type { PickerLook } from './Picker';
import { PickerShell } from './Picker';
import classes from './Picker.module.css';
import { OWN_ESCAPE } from './own-escape';

// When something repeats: Monthly or Weekly as two segments, then its day, as a calendar
// of the month's days 1 to 31 or a row of the week's days. Tapping a day chooses it and
// closes. A computer's opens under the row; a phone's is a sheet that Back closes.

const OFTEN: [Schedule, string][] = [
  ['monthly', 'Monthly'],
  ['weekly', 'Weekly'],
];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function RepeatsPicker({
  label,
  schedule,
  day,
  shown,
  onChange,
  look = 'row',
  className,
}: {
  label: string;
  schedule: Schedule;
  /** 1 to 31 of a month, or 1 (Monday) to 7 (Sunday) of a week */
  day: number;
  /** What the closed picker says, as "Monthly on the 18th" */
  shown: string;
  onChange: (schedule: Schedule, day: number) => void;
  look?: PickerLook;
  className?: string;
}) {
  return (
    <PickerShell
      label={label}
      look={look}
      className={className}
      shown={shown}
      popup="dialog"
      width={300}
      panel={({ close, sheet, id }) => (
        <DayChooser
          id={id}
          label={label}
          sheet={sheet}
          schedule={schedule}
          day={day}
          onPick={(s, d) => {
            close();
            if (s !== schedule || d !== day) onChange(s, d);
          }}
          onClose={close}
        />
      )}
    />
  );
}

function DayChooser({
  id,
  label,
  sheet,
  schedule,
  day,
  onPick,
  onClose,
}: {
  id: string;
  label: string;
  sheet: boolean;
  schedule: Schedule;
  day: number;
  onPick: (schedule: Schedule, day: number) => void;
  onClose: () => void;
}) {
  const [often, setOften] = useState(schedule);
  const days = often === 'monthly' ? 31 : 7;
  const chosen = often === schedule ? day : null;
  // The day the keys move from: the chosen one, else the first
  const [focusDay, setFocusDay] = useState(chosen ?? 1);
  const grid = useRef<HTMLDivElement>(null);

  // A computer's opens with focus on the chosen day; a phone's sheet focuses itself
  useEffect(() => {
    if (!sheet) grid.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [sheet]);

  const switchTo = (next: Schedule) => {
    setOften(next);
    setFocusDay(next === schedule ? day : 1);
  };

  const onDayKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: often === 'monthly' ? 7 : 1,
      ArrowUp: often === 'monthly' ? -7 : -1,
    };
    let to: number | null = null;
    if (e.key in step) to = Math.max(1, Math.min(days, focusDay + step[e.key]));
    else if (e.key === 'Home') to = 1;
    else if (e.key === 'End') to = days;
    if (to == null) return;
    e.preventDefault();
    setFocusDay(to);
    grid.current?.querySelector<HTMLElement>(`[data-day="${to}"]`)?.focus();
  };

  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      className={`${classes.panel} ${classes.repeats}`}
      data-sheet={sheet || undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        role="radiogroup"
        aria-label="How often"
        className={classes.seg}
      >
        {OFTEN.map(([value, name]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={often === value}
            className={classes.segment}
            {...OWN_ESCAPE}
            onClick={() => switchTo(value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const next = often === 'monthly' ? 'weekly' : 'monthly';
              switchTo(next);
              e.currentTarget.parentElement
                ?.querySelector<HTMLElement>(`[data-often="${next}"]`)
                ?.focus();
            }}
            data-often={value}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        ref={grid}
        role="radiogroup"
        aria-label={often === 'monthly' ? 'Day of the month' : 'Day of the week'}
        className={classes.days}
      >
        {Array.from({ length: days }, (_, i) => i + 1).map((d) => (
          <button
            key={`${often}-${d}`}
            type="button"
            role="radio"
            aria-checked={d === chosen}
            aria-label={often === 'weekly' ? WEEKDAYS[d - 1] : undefined}
            tabIndex={d === focusDay ? 0 : -1}
            className={classes.day}
            {...OWN_ESCAPE}
            data-day={d}
            onKeyDown={onDayKey}
            onClick={() => onPick(often, d)}
          >
            {often === 'weekly' ? WEEKDAYS[d - 1].slice(0, 3) : d}
          </button>
        ))}
      </div>
      {often === 'monthly' && (
        <p className={classes.note}>
          The 29th, 30th or 31st, or the month&rsquo;s last day when it&rsquo;s shorter
        </p>
      )}
    </div>
  );
}
