import { pictureAddress } from '@shared/api';
import { nameFor, useProfile } from '../../profile/ProfileContext';

/** A name's first letter, in capitals, for the round initial: "Mei" is "M" */
export const initialOf = (name: string) => ([...name.trim()][0] ?? '').toUpperCase();

/**
 * Who's signed in, as Settings and the initial show them, with the picture shown in the
 * initial's place (one still saving, from this device); null until the profile is known
 */
export function useYou() {
  const { profile } = useProfile();
  if (profile == null) return null;
  const name = nameFor(profile.email, profile.displayName);
  const picture =
    profile.picturePreview ?? (profile.picture == null ? null : pictureAddress(profile.picture));
  return { name, email: profile.email, initial: initialOf(name), picture };
}
