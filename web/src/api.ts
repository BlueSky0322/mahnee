import {
  CLIENT_ID_HEADER,
  EXPECTED_ACCOUNT_HEADER,
  PENDING_CHANGES_HEADER,
  PICTURE_PATH,
  RESPONSE_ACCOUNT_HEADER,
} from '@shared/api';
import type {
  ApiErrorBody,
  ChangesBody,
  ErrorCode,
  ExportRange,
  ExportSummary,
  PayeeCategories,
  Ledger,
  MonthSummary,
  MonthTrend,
  Ok,
  Profile as ApiProfile,
  ProfilePatch,
  RateQuote,
  RecentImports,
  SearchPage,
  TransactionPage,
} from '@shared/api';
import type { PushKey, PushSubscriptionBody } from '@shared/push';
import { newId } from './utils/id';
import {
  accountCheckRequired,
  deviceAccount,
  logoutIntent,
  requireAccountCheck,
  sessionEpoch,
} from './offline/device-session';

/** The signed-in account, as this device holds it */
export type Profile = ApiProfile & {
  /** A picture still being saved, shown from this device meanwhile (an object URL) */
  picturePreview?: string | null;
};

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

const changedAccount = () =>
  new ApiError(409, 'Signed in as someone else.', null, 'account_mismatch');

/** Check the owner again after reading the body, which can finish well after a switch. */
async function send<T>(
  read: (response: Response) => Promise<T>,
  method: string,
  path: string,
  body?: unknown,
  { headers, ...init }: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T> {
  const discovery = method === 'GET' && path === '/api/me';
  const releasingPush = method === 'DELETE' && path === '/api/push/subscription';
  const previous = deviceAccount();
  const epoch = sessionEpoch();
  const expected = writingAs ?? previous;
  const locked = () => !releasingPush && Boolean(logoutIntent());
  if (locked()) throw new ApiError(401, 'Signed out');
  if (!discovery && writingAs != null && previous != null && writingAs !== previous)
    throw changedAccount();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        [CLIENT_ID_HEADER]: CLIENT_ID,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(!discovery && expected != null && { [EXPECTED_ACCOUNT_HEADER]: expected }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch (err) {
    throw new NetworkError(`${method} ${path} got no answer (${String(err)})`);
  }
  if (res.redirected) throw new ApiError(401, `${method} ${path} was sent to sign in`);
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    if (
      method === 'GET' &&
      expected != null &&
      expected === (deviceAccount() ?? writingAs) &&
      answer?.code === 'account_mismatch'
    ) {
      requireAccountCheck();
    }
    throw new ApiError(
      res.status,
      answer?.error ?? `${method} ${path} failed`,
      answer?.error ?? null,
      answer?.code ?? null,
    );
  }
  const value = await read(res);
  const viewer = res.headers.get(RESPONSE_ACCOUNT_HEADER);
  // The first ledger read can start alongside the first profile read, before we know the owner.
  if (!discovery && expected == null && viewer != null && writingAs == null) {
    const me = await (discovering ?? getMe());
    if (viewer !== me.email) throw changedAccount();
  }
  if (locked()) throw new ApiError(401, 'Signed out');
  const current = deviceAccount();
  if (
    !discovery &&
    (accountCheckRequired() || (expected != null && epoch != null && sessionEpoch() !== epoch))
  )
    throw changedAccount();
  if (discovery) {
    if (current !== previous && current !== (value as Profile).email) throw changedAccount();
  } else {
    const owner = expected ?? viewer;
    if (
      owner != null &&
      ((viewer != null && viewer !== owner) ||
        (writingAs != null && writingAs !== owner) ||
        (current !== previous && current !== owner))
    )
      throw changedAccount();
  }
  return value;
}

/** Names the changes still waiting that may be saved already, for a read to answer which are */
const naming = (pending: string[]) =>
  pending.length > 0 ? { headers: { [PENDING_CHANGES_HEADER]: pending.join(',') } } : {};

function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit & { headers?: Record<string, string> },
): Promise<T> {
  return send(
    async (res) => {
      const data = (await res.json().catch(() => null)) as unknown;
      if (data == null) throw new ApiError(502, `${method} ${path} didn't answer with JSON`);
      return data as T;
    },
    method,
    path,
    body,
    init,
  );
}

let discovering: Promise<Profile> | undefined;
function getMe(): Promise<Profile> {
  return (discovering ??= request<Profile>('GET', '/api/me').finally(() => {
    discovering = undefined;
  }));
}

/** An export's days as the address asks for them, nothing for everything */
const rangeQuery = (range: ExportRange | null) =>
  range == null ? '' : `?${new URLSearchParams({ from: range.from, to: range.to }).toString()}`;

function searchPath(search: string, before: string | null, limit: number, rowsOnly = false) {
  const query = new URLSearchParams(search);
  if (before != null) query.set('before', before);
  query.set('limit', String(limit));
  if (rowsOnly) query.set('rowsOnly', '1');
  return `/api/search?${query.toString()}`;
}

export const api = {
  getMe,
  /** The person's imports not undone, newest first */
  getImports: () => request<RecentImports>('GET', '/api/imports'),
  updateMe: (patch: ProfilePatch) => request<Profile>('PATCH', '/api/me', patch),
  /** Keeps a picture (made small on the device) as the one shown in place of the initial */
  putPicture: (picture: Blob) =>
    request<Profile>('PUT', PICTURE_PATH, undefined, {
      body: picture,
      headers: { 'Content-Type': picture.type },
    }),
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
    limit,
    ...which
  }: ({ account: string } | { month: string }) & { before: string | null; limit?: number }) => {
    const query = new URLSearchParams(which);
    if (before != null) query.set('before', before);
    if (limit != null) query.set('limit', String(limit));
    return request<TransactionPage>('GET', `/api/transactions?${query.toString()}`);
  },
  /**
   * What each payee was last filed under, for spending and for income, what was filed on
   * `account` first
   */
  getPayeeCategories: (account: string) =>
    request<PayeeCategories>('GET', `/api/payee-categories?account=${encodeURIComponent(account)}`),
  /**
   * A page of what a search finds (`search`: its address, as shared/search.ts writes it),
   * newest first, with what matches beyond it; `before` is the page before's nextBefore
   */
  search: (search: string, before: string | null, limit: number) =>
    request<SearchPage>('GET', searchPath(search, before, limit)),
  /** The same ordered rows and cursor, without Activity totals. */
  searchRows: (search: string, before: string | null, limit: number) =>
    request<TransactionPage>('GET', searchPath(search, before, limit, true)),
  /** How many transactions the export file holds, over which days; `range` for some dates */
  getExportSummary: (range: ExportRange | null = null) =>
    request<ExportSummary>('GET', `/api/export/summary${rangeQuery(range)}`),
  /**
   * The export file: every transaction, or those of `range`, as CSV. A download cut off
   * part way fails here rather than giving part of the file.
   */
  getExport: (range: ExportRange | null = null) =>
    send(
      async (res) => {
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
      'GET',
      `/api/export${rangeQuery(range)}`,
    ),
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
   * What was spent and received in each of the 12 months ending at `month`, by category,
   * and which of the `pending` change ids it counts already
   */
  getTrend: (month: string, pending: string[] = []) =>
    request<MonthTrend>(
      'GET',
      `/api/summary/trend?month=${encodeURIComponent(month)}`,
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
  /** The key a device subscribes for reminders with; null while the server has none */
  getPushKey: () => request<PushKey>('GET', '/api/push'),
  /** Reminders to this device, for the account signed in */
  subscribePush: (subscription: PushSubscriptionBody) =>
    request<Ok>('PUT', '/api/push/subscription', subscription),
  /** No more reminders to this device, as signing out does */
  unsubscribePush: (endpoint: string, email?: string | null) =>
    request<Ok>(
      'DELETE',
      '/api/push/subscription',
      { endpoint },
      email ? { headers: { [EXPECTED_ACCOUNT_HEADER]: email } } : undefined,
    ),
};
