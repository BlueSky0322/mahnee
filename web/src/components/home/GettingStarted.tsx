import { DoneIcon } from '../ui/icons';
import { useId, useState } from 'react';
import { useAddEntry } from '../shell/add-entry';
import { hideStarted } from './getting-started';
import classes from './Home.module.css';
import PageLink from './PageLink';

/** Which of the five steps are done, worked out from what the person has */
export interface StartedSteps {
  /** What the first step says once done: "Maybank Savings, RM 5,000.00" or "3 accounts" */
  accounts: string;
  logged: boolean;
  pastMonths: boolean;
  scheduled: boolean;
  budget: boolean;
}

/** A step of Getting started, and where it's done */
interface Step {
  title: string;
  line: string;
  done: boolean;
  go?: { label: string; href?: string; push?: boolean };
}

// Getting started on the first days: five steps, each ticked off once its data exists, and
// each still to do a tap from where it's done. The steps done fold away as the person goes,
// a tap from showing again; with one step left it's that one row, with how far along and
// Hide. Hide puts it away on this device.
export default function GettingStarted({
  email,
  steps,
  onHide,
}: {
  email: string;
  steps: StartedSteps;
  onHide: () => void;
}) {
  const titleId = useId();
  const listId = useId();
  const [showDone, setShowDone] = useState(false);
  const done =
    1 + [steps.logged, steps.pastMonths, steps.scheduled, steps.budget].filter(Boolean).length;

  const hide = () => {
    hideStarted(email);
    onHide();
  };

  const rows: Step[] = [
    { title: 'Add where your money is', line: steps.accounts, done: true },
    {
      title: 'Log your first expense',
      line: 'Amount, category, Save',
      done: steps.logged,
      go: { label: 'Add' },
    },
    {
      title: 'Import past transactions',
      line: "From a bank's CSV",
      done: steps.pastMonths,
      go: { label: 'Import', href: '?settings=data', push: true },
    },
    {
      title: 'Add rent, bills and pay',
      line: 'Counted in the month end',
      done: steps.scheduled,
      go: { label: 'Schedule', href: '?plan=scheduled' },
    },
    {
      title: 'Set a budget',
      line: 'A monthly amount per category',
      done: steps.budget,
      go: { label: 'Set one', href: '?settings=categories&budget', push: true },
    },
  ];
  const left = rows.filter((row) => !row.done);
  const finished = rows.filter((row) => row.done);
  const progress = (
    <span className={classes.middle}>
      {`${done} of 5 done · `}
      <button
        type="button"
        className={classes.hide}
        onClick={hide}
      >
        Hide
      </button>
    </span>
  );

  // One step left: that step alone, with how far along and Hide
  if (left.length === 1) {
    return (
      <section
        className={`${classes.card} ${classes.started} ${classes.startedOne}`}
        aria-label="Getting started"
      >
        <StepRow
          row={left[0]}
          showGo={false}
        />
        <div className={classes.startedFoot}>
          <span
            className={classes.startedBar}
            aria-hidden
          >
            <i style={{ width: `${(done * 100) / 5}%` }} />
          </span>
          {progress}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`${classes.card} ${classes.started}`}
      aria-labelledby={titleId}
    >
      <div className={classes.cardHead}>
        <h2
          id={titleId}
          className={classes.cardTitle}
        >
          Getting started
        </h2>
        {progress}
      </div>
      <ul
        id={listId}
        className={classes.steps}
      >
        {[...(showDone ? finished : []), ...left].map((row) => (
          <li key={row.title}>
            <StepRow
              row={row}
              showGo
            />
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={classes.showDone}
        aria-expanded={showDone}
        aria-controls={listId}
        onClick={() => setShowDone((v) => !v)}
      >
        {`${showDone ? 'Hide' : 'Show'} ${finished.length} done`}
      </button>
    </section>
  );
}

/** A step: ticked when done, else the whole row a tap from where it's done (as drawn) */
function StepRow({ row, showGo }: { row: Step; showGo: boolean }) {
  const add = useAddEntry();
  const inside = (
    <>
      <span
        className={row.done ? `${classes.tick} ${classes.tickOn}` : classes.tick}
        aria-hidden
      >
        {row.done && <DoneIcon size={14} />}
      </span>
      <span className={classes.stepText}>
        <b>{row.title}</b>
        <span>{row.line}</span>
      </span>
      {showGo && !row.done && row.go != null && <span className={classes.go}>{row.go.label}</span>}
    </>
  );
  const go = row.done ? undefined : row.go;
  if (go == null || (go.href == null && add == null)) {
    return (
      <div className={row.done ? `${classes.step} ${classes.stepDone}` : classes.step}>
        {inside}
      </div>
    );
  }
  if (go.href == null) {
    return (
      <button
        type="button"
        className={classes.step}
        onClick={() => add?.()}
      >
        {inside}
      </button>
    );
  }
  return (
    <PageLink
      href={go.href}
      push={go.push}
      className={classes.step}
    >
      {inside}
    </PageLink>
  );
}
