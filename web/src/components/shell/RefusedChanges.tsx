import { Button } from '@mantine/core';
import { useState } from 'react';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import { discardRefused, tryAgainRefused } from '../../ledger/ledger';
import { useAccounts, useCategories, useNeedsAttention } from '../../ledger/useLedger';
import { useCurrency } from '../../profile/ProfileContext';
import { describeChange } from './describe-change';
import classes from './RefusedChanges.module.css';

/** "and 1 more change made with it" */
const heldText = (count: number) =>
  `And ${count} more ${count === 1 ? 'change' : 'changes'} made with it or on top of it.`;

/**
 * The changes the server couldn't save, each with its reason: Try again sends it (and
 * what's held with it) again, Discard lets them go for good. Closes once none are left.
 */
export default function RefusedChanges({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const refused = useNeedsAttention();
  const { accounts } = useAccounts();
  const { categories } = useCategories();
  const home = useCurrency();
  // Each set being let go of, so Discard can't be pressed twice
  const [going, setGoing] = useState<ReadonlySet<string>>(new Set());

  const after = (left: number) => {
    if (left === 0) onClose();
  };

  return (
    <ResponsiveDialog
      opened={opened && refused.length > 0}
      onClose={onClose}
      title="Changes not saved"
      subtitle="The server couldn't save these. Try again, or discard them."
    >
      <ul className={classes.list}>
        {refused.map(({ set, reason, queued }) => (
          <li
            key={set}
            className={classes.item}
          >
            <span className={classes.what}>
              {describeChange(queued[0].change, queued[0].currency ?? home, {
                accounts,
                categories,
              })}
            </span>
            <span className={classes.reason}>{reason}</span>
            {queued.length > 1 && (
              <span className={classes.held}>{heldText(queued.length - 1)}</span>
            )}
            <span className={classes.actions}>
              <Button
                size="compact-sm"
                onClick={() => {
                  tryAgainRefused(set);
                  after(refused.length - 1);
                }}
              >
                Try again
              </Button>
              <Button
                size="compact-sm"
                variant="subtle"
                color="red"
                disabled={going.has(set)}
                onClick={() => {
                  setGoing((was) => new Set([...was, set]));
                  void discardRefused(set).then(() => after(refused.length - 1));
                }}
              >
                Discard
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </ResponsiveDialog>
  );
}
