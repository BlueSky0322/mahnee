import { Button } from '@mantine/core';
import { BackIcon } from './icons';

/** Back to the page above, named on the button: a chevron and the name, in ink */
export default function BackButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      variant="subtle"
      size="xs"
      className="sf-back"
      leftSection={<BackIcon size={20} />}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
