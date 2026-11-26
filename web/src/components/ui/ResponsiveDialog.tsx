import { Button, Drawer, Modal } from '@mantine/core';
import type { ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';
import { DialogHeaderSlot } from './dialog-header';
import { useBackDismiss } from '../../hooks/useBackDismiss';
import { useBottomBar } from '../../utils/bottom-bars';
import { useIsMobile } from '../../hooks/useBreakpoints';
import classes from './ResponsiveDialog.module.css';
import { CloseIcon } from './icons';
import { useReturnFocus } from './return-focus';

interface ResponsiveDialogProps {
  opened: boolean;
  onClose: () => void;
  /** Its title; a grouped form draws its own, with DialogTitle */
  title?: ReactNode;
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
  /**
   * A form of grouped rows on the page's colour, drawing its own header (Cancel, its
   * DialogTitle, Save) in place of the title and Close
   */
  grouped?: boolean;
  /** Opened from inside another dialog or sheet, so it shows over that one */
  stacked?: boolean;
}

/** Which shape the dialog it's in takes, so DialogTitle names the right one */
const Shape = createContext<'sheet' | 'dialog'>('dialog');

/** A grouped form's title, in its own header: what the dialog is called */
export const DialogTitle = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) =>
  useContext(Shape) === 'sheet' ? (
    <Drawer.Title className={className}>{children}</Drawer.Title>
  ) : (
    <Modal.Title className={className}>{children}</Modal.Title>
  );

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
  grouped = false,
  stacked = false,
}: ResponsiveDialogProps) => {
  // Over Mantine's own dialogs (200), as its popovers are
  const zIndex = stacked ? 300 : undefined;
  const isMobile = useIsMobile();
  // Back closes the sheet, rather than leaving the page under it
  useBackDismiss(opened, onBack ?? onClose);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const root = useReturnFocus(opened);
  // A phone's sheet is at the foot of the screen: messages show above it
  const sheet = useBottomBar<HTMLDivElement>();

  if (isMobile) {
    return (
      <Drawer.Root
        ref={root}
        opened={opened}
        returnFocus={false}
        onClose={onClose}
        position="bottom"
        size="auto"
        zIndex={zIndex}
        classNames={{
          content: floating
            ? `${classes.sheet} ${classes.floating}`
            : grouped
              ? `${classes.sheet} ${classes.grouped}`
              : classes.sheet,
          header: classes.sheetHeader,
          title: grouped ? classes.groupedTitle : classes.sheetTitle,
          body: grouped ? classes.groupedSheetBody : classes.sheetBody,
        }}
      >
        <Drawer.Overlay
          backgroundOpacity={0.38}
          color="#0f1012"
        />
        <Drawer.Content
          ref={sheet}
          bg={grouped ? 'var(--ground)' : undefined}
        >
          {grouped ? (
            <Drawer.Body>
              <Shape.Provider value="sheet">{children}</Shape.Provider>
            </Drawer.Body>
          ) : (
            <>
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
            </>
          )}
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
      zIndex={zIndex}
      classNames={{
        content: grouped ? `${classes.dialog} ${classes.grouped}` : classes.dialog,
        header: classes.dialogHeader,
        title: grouped ? classes.groupedTitle : classes.title,
        close: classes.close,
        body: grouped ? classes.groupedDialogBody : classes.modalBody,
      }}
    >
      <Modal.Overlay
        backgroundOpacity={0.5}
        color="#0f1012"
      />
      <Modal.Content bg={grouped ? 'var(--ground)' : undefined}>
        {grouped ? (
          <Modal.Body>{children}</Modal.Body>
        ) : (
          <>
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
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
};

export default ResponsiveDialog;
