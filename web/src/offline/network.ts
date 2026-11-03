import { NetworkError } from '../api';

/** The browser says there's no connection */
export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * A failure for want of a connection: the request never reached the server, or the
 * browser says it's offline (when any failure is put down to that)
 */
export const isOfflineFailure = (err: unknown) => err instanceof NetworkError || isOffline();
