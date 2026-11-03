import { Drawer, Modal } from '@mantine/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
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

  if (isMobile) {
    return (
      <Drawer
        opened={opened}
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
      opened={opened}
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
