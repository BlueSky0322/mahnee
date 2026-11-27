# Connect Mahnee to an MCP client

Add this remote Streamable HTTP URL to your MCP client.

```text
https://mahnee-mcp.shitty-app.workers.dev/api/mcp
```

Sign in with your usual Mahnee account. The consent page shows the client name and lets you choose what it can do with your ledger. Read access starts checked. Adding expenses requires an explicit selection.

| Choose on the consent page    | What the client can do                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Read ledger (`ledger:read`)   | See saved balances, categories, transactions including payees and notes, and monthly summaries. |
| Add expenses (`ledger:write`) | Record expenses using account and category IDs you provide.                                     |
| Both                          | Look up accounts and categories, read the ledger and record expenses.                           |

### Codex CLI

```sh
codex mcp add mahnee --url https://mahnee-mcp.shitty-app.workers.dev/api/mcp
```

Follow the browser prompt. If you need to start sign-in manually, run `codex mcp login mahnee`. In a new session, try “How much have I spent this month?” with read access. With both permissions, try “Record RM 8 spent today on coffee from my wallet under Food.” [Codex MCP configuration](https://developers.openai.com/codex/mcp).

### Change or revoke access

Open **Settings → My account → Connected apps** in the hosted Mahnee app. Each connection shows its permissions. Choose **Disconnect** beside the client you want to revoke. To give it different permissions, connect it again and make a new selection. [Connected apps](https://mahnee-mcp.shitty-app.workers.dev/oauth/authorize/connections).

### Reconnect an existing client

The dedicated reader URL stays the same and needs a fresh OAuth login. The former writer URL ending in `/api/mcp/write` returns HTTP 410. The browser app's former MCP URLs also return 410 to signed-in users.

Remove the old writer entry and any custom `cf-access-token` or bearer-token settings. Point one connection at the URL above and sign in again to choose its permissions. In Codex, use `codex mcp remove <old-name>` for obsolete entries. An existing entry with the correct URL and standard OAuth can use `codex mcp logout mahnee` followed by `codex mcp login mahnee`.

## Read tools

Only transactions already saved on the server are visible. Changes made offline appear after the device's outbox syncs.

| Tool                  | Inputs and results                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_accounts`       | Lists accounts, currencies, balances and archive status. A negative card balance is money owed.                                                                                                                        |
| `list_categories`     | Lists category IDs, names, income or expense kind, parent IDs and archive status.                                                                                                                                      |
| `search_transactions` | Finds the latest entries first. Filter by `q`, `account`, `category`, `kind`, or inclusive `from` and `to` dates. The default page is 20, the maximum is 50. Pass `nextBefore` back as `before` with the same filters. |
| `get_month_summary`   | Takes `month` as `YYYY-MM`. Returns your financial month's start and end dates, spending, income, income less spending, and category totals. Transfers are excluded.                                                   |

Amounts are whole cents of the stated currency. Converted entries can also show the original amount and currency. Category totals are largest first and use the IDs from `list_categories`.

## Recording an expense

`record_expense` adds one expense per request. A write-only client receives the signed-in email in the MCP server's initialization instructions and needs the account and category IDs supplied to it. A client with both permissions can get the email from `list_accounts.signedInAs` and look up the IDs with the read tools.

| Input                     | Value                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expectedAccount`         | The signed-in email. Mahnee checks it against the owner of the connection.                                                                                   |
| `requestId`               | A random ID of 16 lowercase hexadecimal characters, generated once per expense.                                                                              |
| `accountId`, `categoryId` | The payment account and expense category. Both must be active.                                                                                               |
| `amountCents`, `currency` | The amount paid in whole cents, from 1 to 1,000,000,000, and the currency it was paid in. Mahnee converts foreign expenses at the rate for the expense date. |
| `date`, `time`            | Date as `YYYY-MM-DD` and optional local time as `HH:MM`.                                                                                                     |
| `payee`, `note`           | Optional text.                                                                                                                                               |

A successful call returns `transactionId`, equal to the request ID. If the reply is lost, resend the same fields and ID. Mahnee returns the saved ID and records the expense once. Reusing a saved ID with different details returns an error.

## Local development

The Worker integration tests run the OAuth client against local storage and a synthetic ledger.

```sh
yarn vitest run worker/test/mcp.test.ts
```

Follow the local app setup to install dependencies, configure a synthetic `DEV_USER_EMAIL` in `.dev.vars`, and migrate local D1. Start the dedicated MCP Worker on loopback with the same email and ledger. Wrangler keeps its OAuth grants in local KV. [Local app setup](../README.md#running-it).

```sh
yarn dev:mcp
```

In another terminal, run `codex mcp add mahnee-local --url http://127.0.0.1:8788/api/mcp` and complete OAuth consent. The local browser identity stands in for Cloudflare Access. The MCP client still obtains and presents its own OAuth token.

## Hosted deployment

The **Deploy MCP** workflow runs after a successful **Build and Deploy** on `main`. It can also be started manually on `main`. It deploys the dedicated Worker against the existing ledger D1 database. It provisions the OAuth KV namespace and a Cloudflare Access application for `/oauth/authorize` and its descendants, using the browser app's reusable sign-in policies. OAuth discovery, client registration and token exchange are accessible to remote clients. Ledger tools require a bearer token issued for this resource.

Deployment uses the repository's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs Workers Scripts, Workers KV Storage, and Access Apps and Policies write permissions. The workflow verifies the active deployment before retiring the former reader and writer Access applications. The optional `WISE_TOKEN` secret enables Wise on this Worker. Frankfurter supplies rates when Wise is unavailable. [Deployment workflow](../.github/workflows/mcp.yml) · [Security and recovery](security.md).
