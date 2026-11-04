import { notifications } from '@mantine/notifications';
import { ApiError } from '../api';

// Saying that something went wrong, the same way everywhere

/** An error whose message is written for the person using the app, so can be shown as is */
export class UserError extends Error {}

/**
 * The server's explanation, or a UserError's message; otherwise (no connection, a
 * browser error) `fallback`, since those messages aren't written for people
 */
export const showError = (err: unknown, fallback: string) =>
  notifications.show({
    color: 'red',
    message:
      (err instanceof ApiError ? err.explanation : err instanceof UserError ? err.message : null) ??
      fallback,
  });

/** Why something can't be done, as worked out here */
export const showRefusal = (message: string) => notifications.show({ color: 'red', message });
