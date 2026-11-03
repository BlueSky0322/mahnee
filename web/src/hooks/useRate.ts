import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SETTINGS } from '@shared/api';
import { rateDay } from '@shared/rates';
import { api } from '../api';
import { useProfile } from '../profile/ProfileContext';
import { queryClient } from '../query-client';

/** A rate this recent is reused rather than fetched again */
const RATE_FRESH_MS = 5 * 60 * 1000;

/**
 * Today's rate from one currency into another, shared by everything that shows one, or
 * with `at` the rate for an amount spent then (an earlier day's, when it was). The server
 * picks the source from the account's settings, so a different source is a different rate.
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
    queryFn: () => api.getRate(from, to, day == null ? {} : { at }),
    enabled: enabled && from !== to,
    staleTime: RATE_FRESH_MS,
    retry: 1,
  });
  /** Fetches a recent rate now, in place of the one shown */
  const refresh = async () => {
    queryClient.setQueryData(key, await api.getRate(from, to, { fresh: true }));
  };
  return { ...query, refresh };
}
