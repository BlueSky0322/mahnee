import { Button, Drawer, Modal } from '@mantine/core';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { DialogHeaderSlot } from './dialog-header';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useIsMobile } from '../../hooks/useBreakpoints';
import classes from './ResponsiveDialog.module.css';
import { CloseIcon } from './icons';
import { useReturnFocus } from './return-focus';

interface ResponsiveDialogProps {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A line under the title, saying what it is about */
  subtitle?: ReactNode;
  children: ReactNode;
  width?: number;
  /**
   * Phones: the quiet button at the top right that closes it ("Cancel" unless named), or
   * null when the form has its own
   */
  closeLabel?: string | null;
  /** Computers: how far down the page the dialog starts, in px */
  top?: number;
  /** Back was pressed (phones): close, or return false to stay open (say, to confirm) */
  onBack?: () => boolean | void;
  /** Phones: a card clear of the screen's edges, for a short question */
  floating?: boolean;
}

// One form, two shapes: a bottom sheet on phones, its title over a line saying what it's
// about with Cancel beside it, and a dialog near the top of a computer's page, with Close
const ResponsiveDialog = ({
  opened,
  onClose,
  title,
  subtitle,
  children,
  width = 440,
  closeLabel = 'Cancel',
  top = 88,
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
      <Drawer.Root
        ref={root}
        opened={opened}
        returnFocus={false}
        onClose={onClose}
        position="bottom"
        size="auto"
        classNames={{
          content: floating ? `${classes.sheet} ${classes.floating}` : classes.sheet,
          header: classes.sheetHeader,
          title: classes.sheetTitle,
          body: classes.sheetBody,
        }}
      >
        <Drawer.Overlay
          backgroundOpacity={0.38}
          color="#0f1012"
        />
        <Drawer.Content>
          <Drawer.Header>
            <div className={classes.heading}>
              <Drawer.Title>{title}</Drawer.Title>
              {subtitle != null && <p className={classes.subtitle}>{subtitle}</p>}
            </div>
            <span
              ref={setSlot}
              className={classes.headerSlot}
            />
            {!floating && closeLabel != null && (
              <Button
                variant="light"
                size="xs"
                onClick={onClose}
              >
                {closeLabel}
              </Button>
            )}
          </Drawer.Header>
          <Drawer.Body>
            <DialogHeaderSlot.Provider value={slot}>{children}</DialogHeaderSlot.Provider>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    );
  }

  return (
    <Modal.Root
      ref={root}
      opened={opened}
      returnFocus={false}
      onClose={onClose}
      size={width}
      yOffset={top}
      classNames={{
        content: classes.dialog,
        header: classes.dialogHeader,
        title: classes.title,
        close: classes.close,
        body: classes.modalBody,
      }}
    >
      <Modal.Overlay
        backgroundOpacity={0.5}
        color="#0f1012"
      />
      <Modal.Content>
        <Modal.Header>
          <div className={classes.heading}>
            <Modal.Title>{title}</Modal.Title>
            {subtitle != null && <p className={classes.subtitle}>{subtitle}</p>}
          </div>
          <Modal.CloseButton
            size={44}
            radius="xl"
            icon={<CloseIcon size={20} />}
            aria-label="Close"
          />
        </Modal.Header>
        <Modal.Body>{children}</Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
};

export default ResponsiveDialog;
