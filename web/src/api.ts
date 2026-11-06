import { CLIENT_ID_HEADER, EXPECTED_ACCOUNT_HEADER, PENDING_CHANGES_HEADER } from '@shared/api';
import type {
  ApiErrorBody,
  ChangesBody,
  ErrorCode,
  ExportSummary,
  Ledger,
  MonthSummary,
  Ok,
  Profile as ApiProfile,
  ProfilePatch,
  RateQuote,
  TransactionPage,
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

/**
 * Sends a request to the API with what every request carries, answering with the response
 * once it's known to be a success; anything else is thrown as an ApiError or NetworkError
 */
async function send(
  method: string,
  path: string,
  body?: unknown,
  { headers, ...init }: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
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
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    const error = answer?.error ?? null;
    throw new ApiError(
      res.status,
      error ?? `${method} ${path} failed`,
      error,
      answer?.code ?? null,
    );
  }
  return res;
}

/** Names the changes still waiting that may be saved already, for a read to answer which are */
const naming = (pending: string[]) =>
  pending.length > 0 ? { headers: { [PENDING_CHANGES_HEADER]: pending.join(',') } } : {};

async function request<T>(...args: Parameters<typeof send>): Promise<T> {
  const res = await send(...args);
  const data = (await res.json().catch(() => null)) as unknown;
  // Answered by something other than the API (a proxy, say): worth trying again, like a 5xx
  if (data == null) throw new ApiError(502, `${args[0]} ${args[1]} didn't answer with JSON`);
  return data as T;
}

export const api = {
  getMe: () => request<Profile>('GET', '/api/me'),
  updateMe: (patch: ProfilePatch) => request<Profile>('PATCH', '/api/me', patch),
  /**
   * The person's accounts and categories, and which of the `pending` change ids (at most
   * MAX_CHANGES) the balances hold already
   */
  getLedger: (pending: string[] = []) =>
    request<Ledger>('GET', '/api/accounts', undefined, naming(pending)),
  /**
   * A page of the person's transactions, newest first: one account's, or every account's
   * in a month (2026-11); `before` is the page before's nextBefore
   */
  getTransactions: ({
    before,
    ...which
  }: ({ account: string } | { month: string }) & { before: string | null }) => {
    const query = new URLSearchParams(which);
    if (before != null) query.set('before', before);
    return request<TransactionPage>('GET', `/api/transactions?${query.toString()}`);
  },
  /** How many transactions the export file holds, over which days */
  getExportSummary: () => request<ExportSummary>('GET', '/api/export/summary'),
  /**
   * The export file: every transaction, as CSV. A download cut off part way fails here
   * rather than giving part of the file.
   */
  getExport: async () => {
    const res = await send('GET', '/api/export');
    // Answered by something other than the API (a proxy, say): not the file
    if (!res.headers.get('Content-Type')?.startsWith('text/csv')) {
      throw new ApiError(502, "GET /api/export didn't answer with the file");
    }
    try {
      return await res.blob();
    } catch (err) {
      throw new NetworkError(`GET /api/export was cut off (${String(err)})`);
    }
  },
  /**
   * What was spent and received in a month (2026-11), in total and by category, and which
   * of the `pending` change ids (at most MAX_CHANGES) it counts already
   */
  getSummary: (month: string, pending: string[] = []) =>
    request<MonthSummary>(
      'GET',
      `/api/summary?month=${encodeURIComponent(month)}`,
      undefined,
      naming(pending),
    ),
  /**
   * Saves a batch of ledger changes, all or nothing (see ledger/save-queue.ts). While the
   * page is hidden or closing, keepalive lets the save finish after it's gone; browsers
   * allow that only for small requests (nextBatch keeps each one small enough), so it's
   * not used otherwise. One that still can't go stays on the device and is sent later.
   */
  saveChanges: (body: ChangesBody) =>
    request<Ok>('POST', '/api/changes', body, {
      keepalive: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    }),
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
