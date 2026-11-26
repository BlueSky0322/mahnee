import { Switch } from '@mantine/core';
import type { ReactNode } from 'react';
import { NewTag } from '../ui/Badge';
import { ForwardIcon } from '../ui/icons';
import { LoadingRows } from '../ui/Skeleton';
import classes from './Settings.module.css';

// What a section of Settings is built from: a row for each setting (its name, what it's
// for, and its control below or beside it), and a choice of one of a few, drawn as a
// segmented control or as colour swatches. A search opens the section with the row it
// found in view (`found`), so each row is named by its setting's key (`data-setting`).

/** A section's settings while the profile loads: a row for each, `rows` of them */
export const SettingsLoading = ({ rows }: { rows: number }) => (
  <LoadingRows
    label="Loading your settings"
    rows={rows}
    icons={false}
  />
);

/** One setting: its name and line, and its control under them (or beside, for a switch) */
export function SettingRow({
  settingKey,
  name,
  line,
  isNew = false,
  found,
  beside = false,
  children,
}: {
  settingKey: string;
  name: string;
  line: string;
  isNew?: boolean;
  found: string | null;
  /** The control sits beside the name (a switch, a value), not under it */
  beside?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`${beside ? classes.row : classes.stacked} ${found === settingKey ? classes.found : ''}`}
      data-setting={settingKey}
      tabIndex={-1}
    >
      <div className={classes.rowText}>
        <div className={classes.settingName}>
          {name}
          {isNew && <NewTag />}
        </div>
        <div className={classes.detail}>{line}</div>
      </div>
      {children}
    </div>
  );
}

/** A setting whose whole row opens a picker. Keep retry actions outside its button. */
export function SettingValueButton({
  settingKey,
  rowClass,
  name,
  line,
  value,
  titleClass = classes.label,
  disabled,
  onClick,
  status,
  after,
}: {
  settingKey: string;
  rowClass: string;
  name: ReactNode;
  line: string;
  value: string;
  titleClass?: string;
  disabled?: boolean;
  onClick: () => void;
  status?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <div
      className={`${rowClass} ${classes.valueHolder}`}
      data-setting={settingKey}
      tabIndex={-1}
    >
      <button
        type="button"
        className={classes.valueButton}
        disabled={disabled}
        onClick={onClick}
      >
        <span className={classes.rowText}>
          <span className={titleClass}>{name}</span> <span className={classes.detail}>{line}</span>
          {status}
        </span>{' '}
        <span className={classes.value}>{value}</span>
        <ForwardIcon
          size={16}
          className={classes.caret}
        />
      </button>
      {after}
    </div>
  );
}

/** One of a few, as a segmented control: a radio group of buttons */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  reselect = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  reselect?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={className == null ? classes.choice : `${classes.choice} ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? classes.choiceOn : undefined}
          onClick={() => {
            if (reselect || o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A setting that is on or off, named for it */
export function OnOff({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
}
