import { Drawer, Modal } from '@mantine/core';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { DialogHeaderSlot } from './dialog-header';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useIsMobile } from '../../hooks/useBreakpoints';
import classes from './ResponsiveDialog.module.css';

interface ResponsiveDialogProps {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
  /** Back was pressed (phones): close, or return false to stay open (say, to confirm) */
  onBack?: () => boolean | void;
  /** Phones: a card clear of the screen's edges, for a short question */
  floating?: boolean;
}

/** How long after closing focus goes back to what opened the dialog, as Mantine does */
const RETURN_FOCUS_MS = 10;

/**
 * Puts focus back on what opened the dialog once it closes, unless it has gone somewhere
 * else since: a toast's Undo reached right after closing keeps it, so Enter undoes
 * rather than opening the dialog again. Mantine's own return takes focus back regardless.
 */
function useReturnFocus(opened: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (opened) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const back = opener.current;
    opener.current = null;
    if (back == null) return;
    const timer = window.setTimeout(() => {
      const now = document.activeElement;
      const leftHere = now == null || now === document.body || root.current?.contains(now);
      if (leftHere) back.focus({ preventScroll: true });
    }, RETURN_FOCUS_MS);
    return () => window.clearTimeout(timer);
  }, [opened]);
  return root;
}

// One form, two shapes: a bottom sheet on phones and a centred dialog elsewhere
const ResponsiveDialog = ({
  opened,
  onClose,
  title,
  children,
  width = 440,
  onBack,
  floating,
}: ResponsiveDialogProps) => {
  const isMobile = useIsMobile();
  // Back closes the sheet, rather than leaving the page under it
  useBackDismiss(opened, onBack ?? onClose);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const root = useReturnFocus(opened);

  if (isMobile) {
    return (
      <Drawer
        ref={root}
        opened={opened}
        returnFocus={false}
        onClose={onClose}
        position="bottom"
        size="auto"
        withCloseButton={!floating}
        title={
          <span className={classes.sheetTitleRow}>
            <span className={classes.sheetTitleText}>{title}</span>
            <span
              ref={setSlot}
              className={classes.headerSlot}
            />
          </span>
        }
        classNames={{
          content: floating ? `${classes.sheet} ${classes.floating}` : classes.sheet,
          header: classes.sheetHeader,
          title: classes.sheetTitle,
          body: classes.sheetBody,
        }}
      >
        <DialogHeaderSlot.Provider value={slot}>{children}</DialogHeaderSlot.Provider>
      </Drawer>
    );
  }

  return (
    <Modal
      ref={root}
      opened={opened}
      returnFocus={false}
      onClose={onClose}
      title={title}
      size={width}
      centered
      classNames={{ title: classes.title, body: classes.modalBody }}
    >
      {children}
    </Modal>
  );
};

export default ResponsiveDialog;
