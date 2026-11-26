import { Button } from '@mantine/core';
import { Archive, ArrowCounterClockwise } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import classes from './FormActions.module.css';

/** A form's secondary action on the left and its submit button on the right. */
export default function FormActions({
  submitLabel = 'Save',
  children,
}: {
  submitLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className={classes.actions}>
      {children}
      <Button
        type="submit"
        className={classes.save}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

export function ArchiveButton({
  archived = false,
  onClick,
}: {
  archived?: boolean;
  onClick: () => void;
}) {
  const Icon = archived ? ArrowCounterClockwise : Archive;
  return (
    <Button
      variant="subtle"
      color="gray"
      leftSection={<Icon size={16} />}
      onClick={onClick}
    >
      {archived ? 'Bring back' : 'Archive'}
    </Button>
  );
}
