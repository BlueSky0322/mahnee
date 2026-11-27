// Record one expense through the same checks, rates and durable receipts as an app entry.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { type ApiErrorBody, ROW_ID_CHARS } from '../../shared/api';
import { isDay, MAX_NOTE, MAX_PAYEE, MAX_TRANSACTION_CENTS } from '../../shared/ledger';
import { ENTRY_CURRENCIES } from '../../shared/rates';
import { isTimeOfDay } from '../../shared/settings';
import type { McpEnv } from '../app';
import { saveLedgerChanges } from '../ledger/changes';

const id = z.string().regex(new RegExp(`^${ROW_ID_CHARS}$`));
const input = z.strictObject({
  expectedAccount: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .describe(
      'Use the signed-in email from the server instructions or signedInAs from list_accounts.',
    ),
  requestId: id.describe('Generate a random ID once per expense. Reuse it for retries.'),
  accountId: id.describe(
    'Active payment account ID. With read access, look it up in list_accounts.',
  ),
  categoryId: id.describe(
    'Active expense category ID. With read access, look it up in list_categories.',
  ),
  date: z.string().length(10).refine(isDay, 'Give a valid expense date in YYYY-MM-DD format.'),
  amountCents: z.number().int().positive().max(MAX_TRANSACTION_CENTS),
  currency: z.enum(ENTRY_CURRENCIES).describe('Currency in which amountCents was entered.'),
  payee: z.string().max(MAX_PAYEE).optional(),
  note: z.string().max(MAX_NOTE).optional(),
  time: z.string().length(5).refine(isTimeOfDay, 'Give a local time in HH:MM format.').optional(),
});

const failed = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
});

export function registerExpenseTool(server: McpServer, env: McpEnv, email: string) {
  server.registerTool(
    'record_expense',
    {
      title: 'Record an expense',
      description:
        'Add one expense. Use whole cents of the explicit currency. Mahnee books foreign amounts at the rate for the expense date. Retrying the same request ID and details records it once.',
      inputSchema: input,
      outputSchema: { transactionId: id },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (expense) => {
      if (expense.expectedAccount.toLowerCase() !== email)
        return failed('The signed-in account changed. Check the email in the server instructions.');
      try {
        const { success } = await env.API_LIMITER.limit({ key: email });
        if (!success)
          return failed('Too many changes. Wait a moment, then retry with the same request ID.');
        const response = await saveLedgerChanges(
          env,
          email,
          {
            ids: [expense.requestId],
            currencies: [expense.currency],
            changes: [
              {
                op: 'addTransaction',
                transaction: {
                  id: expense.requestId,
                  kind: 'expense',
                  accountId: expense.accountId,
                  toAccountId: null,
                  amountCents: expense.amountCents,
                  categoryId: expense.categoryId,
                  date: expense.date,
                  time: expense.time ?? null,
                  payee: expense.payee ?? null,
                  note: expense.note ?? null,
                },
              },
            ],
          },
          'record_expense',
        );
        if (!response.ok) {
          if (response.status >= 500)
            return failed(
              'Could not record the expense right now. Retry with the same request ID.',
            );
          const { error } = await response.json<ApiErrorBody>();
          return failed(
            error === 'That change was saved differently before'
              ? 'That request ID was already used for a different expense.'
              : error,
          );
        }
        const result = { transactionId: expense.requestId };
        return {
          structuredContent: result,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch {
        return failed('Could not confirm the expense. Retry with the same request ID.');
      }
    },
  );
}
