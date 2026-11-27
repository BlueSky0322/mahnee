# Read Mahnee from an MCP client

Connect a Streamable HTTP MCP client to `/api/mcp` to read the signed-in person's
saved ledger. Tool results can contain private financial data, including amounts,
payees and notes. Connect a client you trust with those results.

Mahnee uses the MCP SDK in stateless mode. The endpoint accepts one JSON-RPC
message per HTTP POST and answers with JSON. It has no persistent MCP session or
standalone event stream. Cloudflare Access handles hosted sign-in and the Worker
verifies the Access token before a tool can read data. Tools have no write access
and only see data already saved on the server.

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

## Connect to a local Worker

Follow the [local setup](../README.md#running-it), including the D1 migrations.
Use synthetic data and the local `DEV_USER_EMAIL`. Access is not present on the
local Worker. With that Worker running, add it to Codex CLI:

```sh
codex mcp add mahnee-local --url http://127.0.0.1:8787/api/mcp
```

Start a new Codex session and ask it to call `list_accounts`. An empty local ledger
returns an empty list.

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

Repeat the login when the Access session expires. Use the exact hostname protected
by Access on your deployment. If you set up the dedicated MCP application below,
set `MAHNEE_ACCESS_APP` to its full URL including `/api/mcp` to get that
application's token, or connect using Managed OAuth. Keep tokens out of MCP
configuration values, URLs, logs, and the repository.
[Cloudflare's CLI authentication guide](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/)
and [Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Set up hosted OAuth

Use this when a hosted MCP client needs to sign in through a browser and supports
Cloudflare Managed OAuth, including OAuth resource indicators (RFC 8707). An
operator sets this up in Cloudflare Zero Trust.

1. Serve Mahnee on a [Worker Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
   in an active zone you control, for example `mahnee.example.com`. Protect the new
   hostname with the site-wide Access application for the browser app and its APIs.
   Cloudflare documents
   Worker-level Access on `workers.dev`; the documented path-specific self-hosted
   setup requires an active zone in your account. Use the custom domain for this
   setup and the existing CLI login above for a `workers.dev` deployment.
2. Add a separate self-hosted Access application for the exact path
   `mahnee.example.com/api/mcp`. Give it an Allow policy for the people who may
   connect, and enable **Managed OAuth** under its advanced settings. The more
   specific path policy takes precedence independently of the site-wide policy.
   Keep the rest of the site's authentication unchanged.
3. Set `ACCESS_MCP_AUD` to the **MCP application's** audience tag under the Worker
   `vars` in `wrangler.jsonc` so it persists across deployments. Keep
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set to the team domain and audience the
   rest of Mahnee already uses. The dedicated MCP audience is optional for standard
   Access login and is accepted only at `/api/mcp`.
4. Allow the chosen client's OAuth redirect URI in the MCP application's Managed
   OAuth settings. For a local OAuth client, use Cloudflare's localhost or loopback
   options only if that is where the client returns. Add
   `https://mahnee.example.com/api/mcp` to the client as a remote Streamable HTTP
   MCP server. Follow the Access sign-in prompt with your usual account.

Check that an unauthenticated MCP client receives an OAuth challenge, then sign in
and call `list_accounts`. Check that the browser app still uses its normal login.
Cloudflare handles OAuth discovery, tokens, and session policy. The client presents
an opaque OAuth token to Access. Access passes a signed JWT to the Worker in
`Cf-Access-Jwt-Assertion`. Mahnee checks that JWT and scopes each read to the verified
email. To remove access, update the MCP application's Access policy and revoke the
user's existing Access session in Zero Trust.
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
and [Worker `workers.dev` routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
