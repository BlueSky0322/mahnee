import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { isRowId } from '../../shared/api';
import { categoriesOrDefaults, CATEGORY_KINDS } from '../../shared/categories';
import { ACCOUNT_KINDS, TRANSACTION_KINDS } from '../../shared/ledger';
import { isPeriodMonth } from '../../shared/period';
import { isCalendarDay, MAX_SEARCH_TEXT } from '../../shared/search';
import { listAccounts, listCategories, searchBookedTransactions } from '../ledger/read';
import { readMonthTotals } from '../ledger/summary';

const annotations = { readOnlyHint: true, openWorldHint: false };
const emptyInput = z.strictObject({});
const id = z.string().length(16).refine(isRowId, 'Give a ledger ID.');
const day = z.string().length(10).refine(isCalendarDay, 'Give a date in YYYY-MM-DD format.');
const month = z
  .string()
  .length(7)
  .refine(isPeriodMonth, 'Give a supported month in YYYY-MM format.');
const cents = z.number().int();
const currency = z.string();
const kind = z.enum(TRANSACTION_KINDS);
const categoryTotal = z.object({ categoryId: id, cents, entries: z.number().int() });
const searchInput = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(MAX_SEARCH_TEXT)
      .optional()
      .describe('Payee, note, category name or an exact amount.'),
    account: id
      .optional()
      .describe('Account ID from list_accounts, including transfers in or out.'),
    category: id
      .optional()
      .describe('Category ID from list_categories, including its subcategories.'),
    kind: kind.optional(),
    from: day.optional().describe('First day to include.'),
    to: day.optional().describe('Last day to include.'),
    before: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('nextBefore from the previous page with the same filters.'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .refine(({ from, to }) => from == null || to == null || from <= to, {
    path: ['to'],
    message: 'Use an end date on or after the start date.',
  });
const transaction = z.object({
  id,
  date: day,
  time: z.string().describe('Local time in HH:MM when recorded.').nullable().default(null),
  kind,
  accountId: id,
  toAccountId: id.nullable(),
  categoryId: id.nullable(),
  payee: z.string().describe('Payee entered on the transaction.').nullable(),
  note: z.string().describe('Note entered on the transaction.').nullable(),
  amountCents: cents,
  currency,
  original: z.object({ cents, currency }).optional(),
});

const accountList = z.object({
  accounts: z.array(
    z.object({
      id,
      name: z.string(),
      kind: z.enum(ACCOUNT_KINDS),
      currency,
      balanceCents: cents,
      archived: z.boolean(),
    }),
  ),
});
const writerAccountList = accountList.extend({
  signedInAs: z.string().describe('Copy this ledger owner into record_expense.expectedAccount.'),
});
const categoryList = z.object({
  categories: z.array(
    z.object({
      id,
      name: z.string(),
      kind: z.enum(CATEGORY_KINDS),
      parentId: id.nullable(),
      archived: z.boolean(),
    }),
  ),
});
const transactionPage = z.object({
  transactions: z.array(transaction),
  nextBefore: z.string().describe('Pass as before to fetch the next page.').nullable(),
});
const monthSummary = z.object({
  month,
  firstDay: day,
  lastDay: day,
  currency,
  spentCents: cents,
  incomeCents: cents,
  leftCents: cents,
  spentByCategory: z.array(categoryTotal),
  incomeByCategory: z.array(categoryTotal),
});

const failed = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

/** Keep database failures out of protocol errors, which are visible to the client. */
async function readResult<S extends z.ZodObject>(
  output: S,
  read: () => Promise<z.input<S> | Response>,
): Promise<CallToolResult> {
  try {
    const value = await read();
    if (value instanceof Response)
      return failed(
        value.status === 404
          ? 'Account or category not found.'
          : 'Invalid ledger search or page cursor.',
      );
    // Full ledger rows also carry internal dates, rates and scheduling details. Return only the declared fields.
    const result = output.parse(value);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch {
    return failed('Could not read the ledger. Try again.');
  }
}

export function registerLedgerTools(
  server: McpServer,
  db: D1Database,
  email: string,
  includeIdentity = false,
) {
  const accountsOutput = includeIdentity ? writerAccountList : accountList;
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Accounts and current balances in whole cents of their currency, including archived accounts. A negative card balance is money owed.',
      inputSchema: emptyInput,
      outputSchema: accountsOutput,
      annotations,
    },
    () =>
      readResult(accountsOutput, async () => ({
        accounts: await listAccounts(db, email),
        ...(includeIdentity && { signedInAs: email }),
      })),
  );
  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'Spending and income categories, including archived ones. A subcategory names its parent ID.',
      inputSchema: emptyInput,
      outputSchema: categoryList,
      annotations,
    },
    () =>
      readResult(categoryList, async () => ({
        categories: categoriesOrDefaults(await listCategories(db, email)),
      })),
  );
  server.registerTool(
    'search_transactions',
    {
      title: 'Search transactions',
      description:
        'Search the ledger newest first. Leave filters empty for recent entries. Amounts are whole cents of the stated currency. A transfer leaves accountId and enters toAccountId.',
      inputSchema: searchInput,
      outputSchema: transactionPage,
      annotations,
    },
    (filters) =>
      readResult(transactionPage, () => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined) params.set(key, String(value));
        }
        return searchBookedTransactions(db, email, params);
      }),
  );
  server.registerTool(
    'get_month_summary',
    {
      title: 'Get month summary',
      description:
        'Income, spending and income left after spending, in whole cents of the booked currency. Dates follow the personal month start. Transfers are excluded. Category totals are largest first.',
      inputSchema: z.strictObject({ month }),
      outputSchema: monthSummary,
      annotations,
    },
    ({ month }) => readResult(monthSummary, () => readMonthTotals(db, email, month)),
  );
}
