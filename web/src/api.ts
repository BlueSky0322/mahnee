import { CLIENT_ID_HEADER, EXPECTED_ACCOUNT_HEADER } from '@shared/api';
import type {
  AccountList,
  ApiErrorBody,
  ChangesBody,
  ErrorCode,
  Ok,
  Profile as ApiProfile,
  ProfilePatch,
  RateQuote,
} from '@shared/api';
import { newId } from './utils/id';

/** The signed-in account, as this device holds it */
export type Profile = ApiProfile;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's own explanation, written for the person using the app */
    public explanation: string | null = null,
    /** What went wrong, where the status alone doesn't say */
    public code: ErrorCode | null = null,
  ) {
    super(message);
  }
}

/**
 * The account this page's writes are made as: the one its device copies are kept for
 * (offline/cache.ts sets it). The server refuses a write made as anyone else, so one
 * made before someone else signed in never lands in their account.
 */
let writingAs: string | null = null;
export const writeAs = (email: string | null) => {
  writingAs = email;
};
/** Whom this page's writes are made as now, or null before that's known */
export const writingAccount = () => writingAs;

/** No answer at all: offline, or the connection dropped on the way */
export class NetworkError extends Error {}

/** This tab, sent with every request */
export const CLIENT_ID = newId();

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  { headers, ...init }: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        [CLIENT_ID_HEADER]: CLIENT_ID,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        // Reads don't need it: /api/me is how the page learns who's signed in
        ...(method !== 'GET' && writingAs != null && { [EXPECTED_ACCOUNT_HEADER]: writingAs }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch (err) {
    throw new NetworkError(`${method} ${path} got no answer (${String(err)})`);
  }
  // Sent to the sign-in page: the session has run out
  if (res.redirected) throw new ApiError(401, `${method} ${path} was sent to sign in`);
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const answer = data as Partial<ApiErrorBody> | null;
    const error = answer?.error ?? null;
    throw new ApiError(
      res.status,
      error ?? `${method} ${path} failed`,
      error,
      answer?.code ?? null,
    );
  }
  // Answered by something other than the API (a proxy, say): worth trying again, like a 5xx
  if (data == null) throw new ApiError(502, `${method} ${path} didn't answer with JSON`);
  return data as T;
}

export const api = {
  getMe: () => request<Profile>('GET', '/api/me'),
  updateMe: (patch: ProfilePatch) => request<Profile>('PATCH', '/api/me', patch),
  listAccounts: () => request<AccountList>('GET', '/api/accounts'),
  /** Saves a batch of ledger changes, all or nothing (see ledger/save-queue.ts) */
  saveChanges: (body: ChangesBody) => request<Ok>('POST', '/api/changes', body),
  /**
   * The rate to convert `from` into `to`, for previews: today's, or with `at` the one for
   * an amount spent then. Whatever saves a converted amount converts it again.
   */
  getRate: (
    from: string,
    to: string,
    { fresh = false, at }: { fresh?: boolean; at?: number } = {},
  ) =>
    request<RateQuote>(
      'GET',
      `/api/rates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${
        fresh ? '&fresh=1' : ''
      }${at != null ? `&at=${at}` : ''}`,
    ),
};
