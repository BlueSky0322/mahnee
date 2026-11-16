import { Check } from '@phosphor-icons/react';
import { useId } from 'react';
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

// Getting started on the first days: five steps, each ticked off once its data exists, and
// each still to do a tap from where it's done. Hide puts it away on this device.
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
  const add = useAddEntry();
  const done =
    1 + [steps.logged, steps.pastMonths, steps.scheduled, steps.budget].filter(Boolean).length;

  const hide = () => {
    hideStarted(email);
    onHide();
  };

  const rows: {
    title: string;
    line: string;
    done: boolean;
    go?: { label: string; href?: string; push?: boolean };
  }[] = [
    { title: 'Add where your money is', line: steps.accounts, done: true },
    {
      title: 'Log your first expense',
      line: 'Amount, category, Save',
      done: steps.logged,
      go: { label: 'Add' },
    },
    {
      title: 'Bring in past months',
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
      go: { label: 'Set one', href: '?settings=categories', push: true },
    },
  ];

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
      </div>
      <ul className={classes.steps}>
        {rows.map((row) => {
          const inside = (
            <>
              <span
                className={row.done ? `${classes.tick} ${classes.tickOn}` : classes.tick}
                aria-hidden
              >
                {row.done && <Check size={14} />}
              </span>
              <span className={classes.stepText}>
                <b>{row.title}</b>
                <span>{row.line}</span>
              </span>
              {!row.done && row.go != null && <span className={classes.go}>{row.go.label}</span>}
            </>
          );
          // A step still to do is a tap from where it's done, the whole row (as drawn)
          const go = row.done ? undefined : row.go;
          return (
            <li key={row.title}>
              {go == null || (go.href == null && add == null) ? (
                <div className={row.done ? `${classes.step} ${classes.stepDone}` : classes.step}>
                  {inside}
                </div>
              ) : go.href == null ? (
                <button
                  type="button"
                  className={classes.step}
                  onClick={() => add?.()}
                >
                  {inside}
                </button>
              ) : (
                <PageLink
                  href={go.href}
                  push={go.push}
                  className={classes.step}
                >
                  {inside}
                </PageLink>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
