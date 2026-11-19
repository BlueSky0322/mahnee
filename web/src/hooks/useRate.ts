import { useQuery } from '@tanstack/react-query';
import type { RateQuote } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';
import { rateDay } from '@shared/rates';
import { api } from '../api';
import { readCache, writeCache } from '../offline/cache';
import { isOfflineFailure } from '../offline/network';
import { useProfile } from '../profile/ProfileContext';
import { queryClient } from '../query-client';

/** A rate this recent is reused rather than fetched again */
const RATE_FRESH_MS = 5 * 60 * 1000;

/** A rate as it's shown: fetched now, or (offline) the last one this device was given */
export type ShownRate = RateQuote & { fromDevice: boolean };

/** Where today's rate for a pair is kept on the device, for the person signed in */
const keptKey = (from: string, to: string, source: string) => `rate:${source}:${from}:${to}`;

/**
 * Today's rate from one currency into another, shared by everything that shows one, or
 * with `at` the rate for an amount spent then (an earlier day's, when it was). The server
 * picks the source from the account's settings, so a different source is a different rate.
 * Today's is kept on the device as it comes, so offline the last one known still shows.
 */
export function useRate(
  from: string,
  to: string,
  { enabled = true, at }: { enabled?: boolean; at?: number } = {},
) {
  const source = useProfile().profile?.settings.ratePreference ?? DEFAULT_SETTINGS.ratePreference;
  // Today's rate whenever the amount was spent today, so they share one
  const day = at == null || rateDay(at) >= rateDay(Date.now()) ? null : rateDay(at);
  const key = ['rate', from, to, source, ...(day == null ? [] : [day])];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<ShownRate> => {
      try {
        const quote = await api.getRate(from, to, day == null ? {} : { at });
        if (day == null) void writeCache(keptKey(from, to, source), quote);
        return { ...quote, fromDevice: false };
      } catch (err) {
        const kept =
          day == null && isOfflineFailure(err)
            ? await readCache<RateQuote>(keptKey(from, to, source))
            : undefined;
        if (kept == null) throw err;
        return { ...kept, fromDevice: true };
      }
    },
    enabled: enabled && from !== to,
    staleTime: RATE_FRESH_MS,
    retry: 1,
    // Asked offline too, for the copy kept on the device
    networkMode: 'offlineFirst',
  });
  /** Fetches a recent rate now, in place of the one shown */
  const refresh = async () => {
    const quote = await api.getRate(from, to, { fresh: true });
    void writeCache(keptKey(from, to, source), quote);
    queryClient.setQueryData<ShownRate>(key, { ...quote, fromDevice: false });
  };
  return { ...query, refresh };
}
