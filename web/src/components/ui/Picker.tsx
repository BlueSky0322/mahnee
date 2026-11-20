import { InputBase, Popover } from '@mantine/core';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIsMobile } from '../../hooks/useBreakpoints';
import ResponsiveDialog from './ResponsiveDialog';
import { CheckIcon, DownIcon, ForwardIcon, SearchIcon } from './icons';
import classes from './Picker.module.css';
import { OWN_ESCAPE } from './own-escape';

// One choice from a list, drawn the app's own way rather than the browser's. Closed, it is
// a field, a row of a grouped card, or a bare button, saying what's chosen beside a
// chevron. On a computer or tablet it opens a list under itself; on a phone, a sheet from
// the bottom with large rows, which Back closes. The one chosen is ticked, the list can be
// in titled groups, and a long one has a search.

export interface PickerOption {
  value: string;
  label: string;
  /** The title of the group it is listed under; groups show in the order they first appear */
  group?: string;
  /** Listed, but can't be picked */
  disabled?: boolean;
  /** A colour dot before its name */
  dot?: string;
}

/**
 * How it's drawn closed: a form field with its label above, a row of a grouped card with
 * its label at the left, or just the button (its label read out, not drawn)
 */
export type PickerLook = 'field' | 'row' | 'plain';

/** Lists longer than this have a search */
const SEARCH_FROM = 12;
/** How long typed letters keep adding up to jump to a choice */
const TYPE_AHEAD_MS = 700;

interface FrameProps {
  /** Its name, drawn as the field's or row's label and the sheet's title */
  'label': string;
  'look'?: PickerLook;
  'description'?: ReactNode;
  'error'?: ReactNode;
  'disabled'?: boolean;
  /** The field's or row's own class */
  'className'?: string;
  /** A field's parts, as Mantine names them */
  'classNames'?: { root?: string; label?: string; input?: string };
  /** Computers: the list's least width, in px */
  'width'?: number;
  /** Set on the field or row, for its screen's styles */
  'data-other'?: boolean;
}

interface Shell extends FrameProps {
  /** What the closed picker says */
  shown: ReactNode;
  /** Nothing is chosen yet: what it says is a prompt, drawn quieter */
  prompt?: boolean;
  dot?: string;
  /** The chosen value, kept on the button as a form control's is */
  value?: string;
  popup: 'listbox' | 'dialog';
  /**
   * What opens: told how to close, whether it's in a phone's sheet, its id, and a letter
   * typed on the closed picker that opened it
   */
  panel: (open: { close: () => void; sheet: boolean; id: string; typed: string }) => ReactNode;
}

const dotStyle = (dot: string) => ({ '--dot': dot }) as CSSProperties;

/** Keeps Escape in what's open from also closing a dialog the picker is in */
function keepEscape(e: KeyboardEvent<HTMLElement>) {
  if (e.key === 'Escape' && !e.currentTarget.contains(e.target as Node)) e.stopPropagation();
}

/** The closed picker, and what it opens: a list under it, or a phone's sheet */
export function PickerShell({
  label,
  look = 'field',
  description,
  error,
  disabled,
  className,
  classNames,
  width = 240,
  shown,
  prompt = false,
  dot,
  value: chosen,
  popup,
  panel,
  ...data
}: Shell) {
  const sheet = useIsMobile();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  // A list or sheet is only made once the picker is first opened, so a page of many (an
  // import's rows) draws just their buttons until then
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  const ids = { trigger: useId(), label: useId(), value: useId(), panel: useId() };
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    // A phone's sheet puts focus back itself, once it has gone
    if (!sheet) trigger.current?.focus();
  }, [sheet]);

  const roles = {
    'role': 'combobox',
    // Read out as its name and then what's chosen, as the browser's own list is
    'aria-labelledby': `${ids.label} ${ids.value}`,
    'aria-haspopup': popup,
    'aria-expanded': open,
    'aria-controls': open ? ids.panel : undefined,
    'aria-invalid': error != null && error !== false ? true : undefined,
    'value': chosen,
    'onClick': () => {
      setTyped('');
      setOpen((now) => !now);
    },
    'onKeyDown': (e: KeyboardEvent<HTMLButtonElement>) => {
      if (open) return;
      // As the browser's own list does: the arrows open it, and a letter opens it at the
      // first choice it starts
      const letter = e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && !letter) return;
      e.preventDefault();
      setTyped(letter ? e.key : '');
      setOpen(true);
    },
  } as const;
  const value = (
    <>
      {dot != null && (
        <span
          className={classes.dot}
          style={dotStyle(dot)}
          aria-hidden
        />
      )}
      <span
        id={ids.value}
        className={classes.valueText}
        data-prompt={prompt || undefined}
      >
        {shown}
      </span>
    </>
  );

  // A computer's list, under the field or row: anchored to a box over it, so it can be added
  // on first opening without remaking the button that has focus
  const popover = !sheet && used && (
    <Popover
      opened={open}
      onChange={setOpen}
      position="bottom-start"
      offset={6}
      width={look === 'field' ? 'target' : undefined}
      zIndex={300}
      withinPortal
      withRoles={false}
      closeOnEscape={false}
      returnFocus={false}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>
        <span
          className={classes.anchorBox}
          aria-hidden
        />
      </Popover.Target>
      <Popover.Dropdown
        className={classes.pop}
        style={{ minWidth: width }}
      >
        {open && panel({ close, sheet: false, id: ids.panel, typed })}
      </Popover.Dropdown>
    </Popover>
  );

  let closed: ReactNode;
  if (look === 'field') {
    closed = (
      <InputBase
        ref={trigger}
        id={ids.trigger}
        component="button"
        type="button"
        pointer
        label={label}
        labelProps={{ id: ids.label }}
        description={description}
        error={error}
        disabled={disabled}
        className={className}
        classNames={{ ...classNames, input: `${classes.fieldInput} ${classNames?.input ?? ''}` }}
        rightSection={
          <DownIcon
            size={16}
            aria-hidden
          />
        }
        rightSectionPointerEvents="none"
        inputContainer={(input) => (
          <div className={classes.anchored}>
            {input}
            {popover}
          </div>
        )}
        {...data}
        {...roles}
      >
        <span className={classes.fieldValue}>{value}</span>
      </InputBase>
    );
  } else if (look === 'row') {
    closed = (
      <div
        className={`${classes.row} ${className ?? ''}`}
        {...data}
      >
        <label
          id={ids.label}
          htmlFor={ids.trigger}
          className={classes.rowLabel}
        >
          {label}
        </label>
        <button
          ref={trigger}
          id={ids.trigger}
          type="button"
          className={classes.rowButton}
          disabled={disabled}
          {...roles}
        >
          <span className={classes.rowValue}>{value}</span>
          <ForwardIcon
            size={16}
            className={classes.chevron}
            aria-hidden
          />
        </button>
        {popover}
      </div>
    );
  } else {
    closed = (
      <span className={classes.anchored}>
        <span
          id={ids.label}
          hidden
        >
          {label}
        </span>
        <button
          ref={trigger}
          id={ids.trigger}
          type="button"
          className={`${classes.plain} ${className ?? ''}`}
          disabled={disabled}
          {...data}
          {...roles}
        >
          {value}
          <DownIcon
            size={14}
            className={classes.chevron}
            aria-hidden
          />
        </button>
        {popover}
      </span>
    );
  }

  return (
    <div
      className={classes.contents}
      onKeyDown={keepEscape}
    >
      {closed}
      {sheet && used && (
        <ResponsiveDialog
          opened={open}
          onClose={() => setOpen(false)}
          title={label}
          stacked
        >
          {open && panel({ close, sheet: true, id: ids.panel, typed })}
        </ResponsiveDialog>
      )}
    </div>
  );
}

interface PickerProps extends FrameProps {
  value: string;
  /** What can be picked; a plain string is its own value and label */
  options: readonly (PickerOption | string)[];
  onChange: (value: string) => void;
  /** Said while what's chosen isn't one of the options */
  placeholder?: string;
  /** Whether the list has a search; long lists have one unless told */
  searchable?: boolean;
}

/** A single choice from a list (see the top of this file) */
export default function Picker({
  value,
  options,
  onChange,
  placeholder = '',
  searchable,
  ...frame
}: PickerProps) {
  const list = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const chosen = list.find((o) => o.value === value);
  return (
    <PickerShell
      {...frame}
      popup="listbox"
      value={value}
      shown={chosen?.label ?? placeholder}
      prompt={chosen == null}
      dot={chosen?.dot}
      panel={({ close, sheet, id, typed }) => (
        <OptionList
          id={id}
          typed={typed}
          label={frame.label}
          options={list}
          value={value}
          sheet={sheet}
          searchable={searchable ?? list.length > SEARCH_FROM}
          onPick={(picked) => {
            close();
            if (picked !== value) onChange(picked);
          }}
          onClose={close}
        />
      )}
    />
  );
}

/** The options, in their groups, one of them chosen */
function OptionList({
  id,
  typed: typedFirst,
  label,
  options,
  value,
  sheet,
  searchable,
  onPick,
  onClose,
}: {
  id: string;
  /** A letter typed on the closed picker, to start at the first choice it starts */
  typed: string;
  label: string;
  options: PickerOption[];
  value: string;
  sheet: boolean;
  searchable: boolean;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [words, setWords] = useState('');
  const wanted = words.trim().toLowerCase();
  const shown = options.filter((o) => wanted === '' || o.label.toLowerCase().includes(wanted));
  const pickable = shown.filter((o) => o.disabled !== true);
  const [active, setActive] = useState(() => {
    const first = typedFirst.toLowerCase();
    const starts = options.find(
      (o) => first !== '' && o.disabled !== true && o.label.toLowerCase().startsWith(first),
    );
    return starts?.value ?? value;
  });
  const current = pickable.some((o) => o.value === active) ? active : pickable[0]?.value;
  const optionId = (v: string) => `${id}-${options.findIndex((o) => o.value === v)}`;
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: typedFirst, at: Date.now() });

  // A computer's list takes focus as it opens, in its search if it has one; a phone's sheet
  // focuses the list itself, so the keyboard only comes up when the search is tapped
  useEffect(() => {
    if (!sheet) (search.current ?? list.current)?.focus();
  }, [sheet]);

  // The active option stays in sight as the keys move through a long list
  useEffect(() => {
    if (current == null) return;
    const el = document.getElementById(optionId(current));
    if (el != null && 'scrollIntoView' in el) void el.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the active one moves
  }, [current]);

  const move = (to: number) => {
    const at = Math.max(0, Math.min(pickable.length - 1, to));
    const next = pickable[at];
    if (next != null) setActive(next.value);
  };
  const at = pickable.findIndex((o) => o.value === current);

  /** Letters typed in a row jump to the first choice they start */
  const typeAhead = (key: string) => {
    const now = Date.now();
    const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : '') + key;
    typed.current = { text, at: now };
    const wantedStart = text.toLowerCase();
    // The same letter again steps through the choices starting with it
    const same = [...wantedStart].every((c) => c === wantedStart[0]);
    const from = same ? at + 1 : Math.max(at, 0);
    const prefix = same ? wantedStart[0] : wantedStart;
    const ordered = [...pickable.slice(from), ...pickable.slice(0, from)];
    const hit = ordered.find((o) => o.label.toLowerCase().startsWith(prefix));
    if (hit != null) setActive(hit.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const inList = e.currentTarget === list.current;
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home' && inList) move(0);
    else if (e.key === 'End' && inList) move(pickable.length - 1);
    else if (e.key === 'Enter' || (e.key === ' ' && inList)) {
      if (current != null) onPick(current);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab' && !sheet) {
      onClose();
    } else if (inList && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typeAhead(e.key);
    } else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  // In the order each group first appears; ungrouped options are a group without a title
  const groups: [string | undefined, PickerOption[]][] = [];
  for (const o of shown) {
    const group = groups.find(([title]) => title === o.group);
    if (group == null) groups.push([o.group, [o]]);
    else group[1].push(o);
  }

  const option = (o: PickerOption) => (
    <div
      key={o.value}
      id={optionId(o.value)}
      role="option"
      aria-selected={o.value === value}
      aria-disabled={o.disabled === true || undefined}
      className={classes.option}
      data-active={(o.value === current && o.disabled !== true) || undefined}
      onMouseMove={() => o.disabled !== true && o.value !== current && setActive(o.value)}
      onClick={() => o.disabled !== true && onPick(o.value)}
    >
      {o.dot != null && (
        <span
          className={classes.dot}
          style={dotStyle(o.dot)}
          aria-hidden
        />
      )}
      <span className={classes.optionText}>{o.label}</span>
      <span className={classes.tick}>
        {o.value === value && (
          <CheckIcon
            size={sheet ? 18 : 16}
            aria-hidden
          />
        )}
      </span>
    </div>
  );

  return (
    <div
      className={classes.panel}
      data-sheet={sheet || undefined}
    >
      {searchable && (
        <label className={classes.search}>
          <SearchIcon
            size={16}
            aria-hidden
          />
          <input
            ref={search}
            type="search"
            placeholder="Search"
            aria-label={`Search ${label.toLowerCase()}`}
            aria-controls={id}
            aria-activedescendant={current == null ? undefined : optionId(current)}
            autoComplete="off"
            {...OWN_ESCAPE}
            value={words}
            onChange={(e) => setWords(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </label>
      )}
      <div
        ref={list}
        id={id}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        aria-activedescendant={current == null ? undefined : optionId(current)}
        className={classes.list}
        data-autofocus
        {...OWN_ESCAPE}
        onKeyDown={onKeyDown}
      >
        {groups.map(([title, members], at) =>
          title == null ? (
            members.map(option)
          ) : (
            <div
              key={title}
              role="group"
              aria-labelledby={`${id}-g${at}`}
            >
              <div
                id={`${id}-g${at}`}
                className={classes.group}
              >
                {title}
              </div>
              {members.map(option)}
            </div>
          ),
        )}
      </div>
      {shown.length === 0 && (
        <p className={classes.none}>Nothing matches &ldquo;{words.trim()}&rdquo;</p>
      )}
    </div>
  );
}
