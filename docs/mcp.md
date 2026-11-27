# Connect Mahnee to an MCP client

Connect a Streamable HTTP MCP client to `/api/mcp` to read the signed-in person's
saved ledger. Tool results can contain private financial data, including amounts,
payees and notes. Connect a client you trust with those results.

Mahnee uses the MCP SDK in stateless mode. The endpoint accepts one JSON-RPC
message per HTTP POST and answers with JSON. It has no persistent MCP session or
standalone event stream. Cloudflare Access handles hosted sign-in and the Worker
verifies the Access token before a tool can read data. `/api/mcp` has read-only tools
and only sees data already saved on the server. A separate endpoint,
`/api/mcp/write`, can add expenses when an operator enables it.

## Tools

| Tool                  | Inputs and results                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_accounts`       | No arguments. Lists accounts with their ids, names, kinds, currencies, balances and archive status.                                                  |
| `list_categories`     | No arguments. Lists categories, including defaults, with ids, names, kinds, parent ids and archive status.                                           |
| `search_transactions` | Searches newest first by optional text, account, category, kind and dates. Defaults to 20, up to 50.                                                 |
| `get_month_summary`   | Takes `month` as `YYYY-MM`. Gives the budget month's boundaries, spent, received and remaining amounts in the home currency. Transfers are excluded. |

For transaction searches, pass `q` for text, account and category ids in `account`
and `category`, and `expense`, `income` or `transfer` for `kind`. The `from` and
`to` filters use `YYYY-MM-DD`. Set the page size with `limit` and pass a returned
`nextBefore` value as `before` to continue.

Amounts with names ending in `Cents` or named `cents` are whole cents. Account balances
use each account's currency. Transactions include their currency and can include the
original amount and currency for converted entries. Month summaries break down spending
and income by category, largest first. Use `list_categories` to look up the category names.

### Writer tools

Use the writer connection's `list_accounts` to identify the signed-in email in
`signedInAs` and the payment account's id. Use `list_categories` to find an expense
category. `record_expense` takes these fields:

| Field                     | Value                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `expectedAccount`         | The writer's `signedInAs` email. The Worker refuses an expense if this differs from the authenticated email.                                                       |
| `requestId`               | A random id of 16 lowercase hexadecimal characters. Generate one for each distinct expense.                                                                        |
| `accountId`, `categoryId` | Ids of the payment account and an expense category. Archived accounts or categories are refused.                                                                   |
| `date`, `time`            | Date as `YYYY-MM-DD`. Optional local time as `HH:MM`.                                                                                                              |
| `amountCents`, `currency` | Amount paid in whole cents, from 1 to 1,000,000,000, and the currency it was paid in. Mahnee uses its normal exchange rate for that date when it needs to convert. |
| `payee`, `note`           | Optional text.                                                                                                                                                     |

A saved expense returns `transactionId`, which is the `requestId` you sent. If the
answer is lost or the client needs to retry, resend the same inputs with the same
id. An identical retry returns the same transaction id and creates no second
expense. Once an id has been saved, a request reusing it with changed inputs is refused.

## Connect to a local Worker

Follow the [local setup](../README.md#running-it), including the D1 migrations.
Use synthetic data and the local `DEV_USER_EMAIL`. Access is not present on the
local Worker. With that Worker running, add it to Codex CLI:

```sh
codex mcp add mahnee-local --url http://127.0.0.1:8787/api/mcp
```

Start a new Codex session and ask it to call `list_accounts`. An empty local ledger
returns an empty list.

To try the expense writer with synthetic data, set `DEV_MCP_WRITES=true` in
`.dev.vars` and restart the local Worker. Register the writer separately:

```sh
codex mcp add mahnee-expenses-local --url http://127.0.0.1:8787/api/mcp/write
```

Use the writer's `list_accounts` to see its `signedInAs` value and the destination
account id. Keep the local opt-in out of the deployed Worker's variables.

## Connect through your existing Access application

For a local MCP client that accepts custom HTTP headers, [install
`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
and sign in to Mahnee with your usual account. The regular Access application's
token can perform ordinary app actions as you, including writes. Pass it only to
a trusted local client. In the following Codex example, add this to your local Codex
`config.toml` and replace the example hostname:

```toml
[mcp_servers.mahnee]
url = "https://mahnee.example.com/api/mcp"
env_http_headers = { "cf-access-token" = "MAHNEE_ACCESS_TOKEN" }
```

Run these commands in the same shell. The login opens a browser. The token is
passed to the client process and the config stores only the environment variable name.

```sh
MAHNEE_ACCESS_APP=https://mahnee.example.com
cloudflared access login "$MAHNEE_ACCESS_APP" >/dev/null &&
  MAHNEE_ACCESS_TOKEN="$(cloudflared access token -app="$MAHNEE_ACCESS_APP")" &&
  MAHNEE_ACCESS_TOKEN="$MAHNEE_ACCESS_TOKEN" codex
unset MAHNEE_ACCESS_TOKEN
```

The original browser app's `/api/mcp` remains available for read-only tools to
every signed-in Mahnee user. Use the original app hostname in the config and
`MAHNEE_ACCESS_APP`, even if the dedicated Worker has been deployed. Repeat the
login when the Access session expires. Keep tokens out of MCP configuration
values, URLs, logs, and the repository.

To check the original read endpoint with curl, run the same Access login first,
then make an MCP initialization request:

```sh
MAHNEE_ACCESS_TOKEN="$(cloudflared access token -app="$MAHNEE_ACCESS_APP")" &&
  printf 'cf-access-token: %s\n' "$MAHNEE_ACCESS_TOKEN" |
    curl --silent --show-error --fail-with-body --header @- \
      --header 'Content-Type: application/json' \
      --header 'Accept: application/json, text/event-stream' \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mahnee-curl","version":"1"}}}' \
      "$MAHNEE_ACCESS_APP/api/mcp"
unset MAHNEE_ACCESS_TOKEN
```

[Cloudflare's CLI authentication guide](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
and [Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Deploy the dedicated MCP Worker

The hosted deployment uses a separate Worker on Cloudflare's `workers.dev`
hostname. Once provisioned, use these Streamable HTTP URLs, replacing
`<workers-subdomain>` with the account's Workers subdomain:

| Access       | Client URL                                                         |
| ------------ | ------------------------------------------------------------------ |
| Read ledger  | `https://mahnee-mcp.<workers-subdomain>.workers.dev/api/mcp`       |
| Add expenses | `https://mahnee-mcp.<workers-subdomain>.workers.dev/api/mcp/write` |

The dedicated Worker serves these MCP routes. The browser app and its other APIs
stay on the existing Mahnee Worker. This setup needs a Workers subdomain in the
Cloudflare account. It does not require a DNS zone you own.

The **Deploy MCP** GitHub Actions workflow provisions the Worker and its
Cloudflare Access applications automatically after a successful **Build and Deploy**
run on `main`. To retry, run **Deploy MCP** manually on `main`. It uses the
existing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` Actions secrets. The
token needs **Workers Scripts Write** and **Access: Apps and Policies Read/Write**
in the deployment account, in addition to the existing release permissions.

The two MCP URLs use separate Cloudflare Access applications. Both reference the
browser app's reusable policies in the same order, so a change to a shared rule
applies to all three. If the browser app still uses application-specific policies,
the workflow stops before creating either application.
The reader application uses the `ACCESS_MCP_AUD` audience. The writer application
uses `ACCESS_MCP_WRITE_AUD`, which must differ from the reader's audience and the
browser app's `ACCESS_AUD`. The writer stays disabled until its audience is
configured. Both applications use Mahnee's existing human sign-in eligibility.
A person connects and authorizes their client separately for each endpoint.
Each connection can access only that person's ledger.

### Connect with Managed OAuth

The initial configuration accepts local clients that return to `127.0.0.1`, including
Codex CLI. For a hosted client, add its documented callback URL to the intended
Access application's Managed OAuth redirect allowlist. Deployments preserve these entries.

1. Add the intended URL to the client as a remote Streamable HTTP server. The
   client needs to support OAuth resource indicators (RFC 8707). Follow the
   Access sign-in prompt with your usual account.
2. Check that an unauthenticated client receives the OAuth challenge and that
   `list_accounts` works after sign-in. In the writer connection, confirm the
   `signedInAs` email before using it as `expectedAccount` in an expense request.

The client presents an opaque OAuth token to Access. Access forwards a signed
JWT in `Cf-Access-Jwt-Assertion`. Mahnee checks the JWT and uses the verified email
for all ledger access. To remove a user's Mahnee access, update the shared policy
and revoke their existing Access sessions in Zero Trust.

A trusted local client that supports custom HTTP headers can use the
[CLI setup above](#connect-through-your-existing-access-application). Use the
dedicated URL, including the full path, in both `url` and `MAHNEE_ACCESS_APP`
to obtain the token for that application. Keep the reader and writer as
separate client entries.

### Optional custom domain

On a domain in a Cloudflare zone you control, you can use a
[Worker Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
In Zero Trust, configure separate self-hosted Access applications for the exact
`/api/mcp` and `/api/mcp/write` paths, using the same audience and Allow policy
separation. Enable Managed OAuth for the clients that use it.

[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
and [Worker `workers.dev` routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
