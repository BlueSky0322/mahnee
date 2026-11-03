import { ActionIcon, Tooltip, useComputedColorScheme } from '@mantine/core';
import { Moon, Sun } from '@phosphor-icons/react';
import { useProfile } from '../../profile/ProfileContext';

/**
 * Flips between light and dark in one tap: the opposite of what's showing now. Until it's
 * first tapped, the app matches the device.
 */
const ThemeToggle = ({ size = 30 }: { size?: number }) => {
  const { rememberSettings } = useProfile();
  const scheme = useComputedColorScheme('dark', { getInitialValueInEffect: false });
  const next = scheme === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={size}
        onClick={() => rememberSettings({ theme: next })}
        aria-label={label}
      >
        {next === 'light' ? <Sun size={18} /> : <Moon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
};

export default ThemeToggle;
