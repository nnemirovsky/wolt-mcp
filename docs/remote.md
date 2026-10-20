# Remote mode

By default wolt-mcp speaks stdio: your MCP client starts it as a child process on your own machine. Remote mode runs the same server as an HTTPS endpoint, so clients that can only talk to a URL — ChatGPT's custom MCP servers, Claude.ai connectors (and through them the Claude iPhone app), Claude Code on another machine — can use your Wolt account from anywhere.

```
node server.mjs --http          # or: WOLT_HTTP_PORT=3000 node server.mjs
```

What changes compared to stdio:

- **Transport** is Streamable HTTP at `/mcp`, stateless: every request builds a fresh server, nothing is kept between calls, and restarts are invisible to clients. There is no session to resume, so `GET /mcp` answers 405.
- **Auth** is OAuth 2.1, served by wolt-mcp itself (see below). Clients discover it from the 401 on `/mcp`, register themselves, send you to an approve page once, and hold a bearer token from then on.
- **Browser login is gone.** A server has no Chrome to drive, so `login_via_chrome` is not offered. Get a Wolt refresh token by running `npx -y wolt-mcp login` on your own computer — it opens the usual browser login and prints the token — and paste it either on the approve page when you connect a client (see below) or later in chat with `set_wolt_token`.
- **Location is per account, never guessed.** Locally the first search falls back to a city-level guess from your IP. A server's IP says where the server is, so remotely there is no guess: each account starts with no location and the model asks, or pulls it with `use_saved_address`.
- **One consumer per Wolt refresh chain.** Wolt's refresh tokens rotate, and two processes refreshing from the same chain eventually trip over each other. Once the remote server works, point your desktop clients at the URL too instead of running stdio copies alongside it; different accounts, or separate logins of the same account, are independent chains and coexist fine.

## Wolt accounts per connection

Every OAuth grant can carry its own Wolt account. The approve page has a **Wolt refresh token** field: paste one and the token is exchanged once right there (a bad paste fails on the page, not at the first tool call), the grant gets a private slot under `<state dir>/accounts/<id>/` with its own `tokens.json` and `config.json`, and every tool call made with that grant — including its refreshes — reads and writes only that slot. Leave the field empty and the grant uses the server's own account, the one the operator connected in the state directory root. When the server has no account of its own yet, the field is shown open; otherwise it is folded behind "Use a different Wolt account for this connection".

So one server can serve several people in several countries, each with their own Wolt login, address and currency, as long as each of them can pass the approve-page guard. Fixed `WOLT_API_TOKENS` bearers always use the server's own account.

## Configuration

All settings are environment variables.

| Variable | Meaning |
|---|---|
| `WOLT_HTTP_PORT`, `WOLT_HTTP_HOST` | Where to listen. Defaults `3000` and `127.0.0.1`; the Docker image sets `0.0.0.0`. |
| `WOLT_PUBLIC_URL` | The https origin clients use, e.g. `https://wolt.example.com`. Required in OAuth mode; it is the OAuth issuer and the resource identifier. |
| `WOLT_CF_ACCESS_TEAM`, `WOLT_CF_ACCESS_AUD` | Guard the approve page with Cloudflare Access: your team domain (`myteam.cloudflareaccess.com`) and the Access application's Audience tag. `WOLT_CF_ACCESS_EMAILS` optionally narrows who may approve. |
| `WOLT_OAUTH_APPROVE_SECRET` | The other guard: a secret (16+ characters) typed into the approve page. Use this when there is no Cloudflare in front. |
| `WOLT_OAUTH_CLIENT_ID`, `WOLT_OAUTH_CLIENT_SECRET` | Optional fixed client for ChatGPT's "static credentials" OAuth option. `WOLT_OAUTH_REDIRECT_URIS` lists its callbacks; the default covers ChatGPT and Claude. |
| `WOLT_API_TOKENS` | Optional comma-separated long-lived bearer tokens (32+ characters each) for clients that can only send a fixed `Authorization` header, such as a desktop agent's "bearer token" field or an iOS Shortcut. |
| `WOLT_HTTP_AUTH=none` | Disables auth entirely. Only for a private network you trust; it is announced loudly on stderr. |
| `WOLT_STATE_DIR` | Where tokens and the saved location live. `/data` in Docker. |

## How the OAuth flow works

wolt-mcp is both the authorization server and the protected resource. There is no identity provider to delegate to — the thing being protected is one person's Wolt account — so the "login" is whichever guard you configured, and the rest is standard OAuth 2.1:

1. A client POSTs `/mcp` without a token and gets a 401 whose `WWW-Authenticate` header points at `/.well-known/oauth-protected-resource`. That names this same origin as the authorization server, whose metadata at `/.well-known/oauth-authorization-server` lists the endpoints.
2. The client registers itself at `/register` (RFC 7591), or uses the static client you configured. Registration is open: it buys nothing without step 3.
3. The client opens `/authorize` in your browser with a PKCE challenge. With the Cloudflare Access guard, Access makes you log in (Google, one-time PIN, whatever your policy allows) and forwards its signed JWT; wolt-mcp verifies the signature, issuer, audience and expiry against your team's public keys. With the secret guard, the page asks for the secret. In both cases you click **Allow** — there is no silent approval, because any site could otherwise register a client and collect a code from a logged-in browser.
4. The client exchanges the code at `/token` (PKCE verifier checked, client secret checked if the client has one) for an opaque bearer token valid 7 days and a refresh token valid 90 days. Refresh tokens rotate; a superseded one keeps working for a minute so a lost response doesn't strand the client.
5. Every tool call carries `Authorization: Bearer …`. Tokens are stored hashed in `<state dir>/oauth.json`, mode 600.

Tool annotations are set so clients know what each tool does before calling it: every search and read tool is `readOnlyHint: true`, basket and account writes are not, and `clear_basket` is flagged destructive. ChatGPT, for one, asks for confirmation on every tool without the read-only hint.

## Deploying with Docker and Cloudflare Tunnel

`deploy/` has a Dockerfile, a compose file and `.env.example`. The compose file runs wolt-mcp next to a `cloudflared` connector, so nothing listens on the host; Cloudflare terminates TLS and forwards your hostname into the container network.

1. In Cloudflare Zero Trust, create an **Access application** for `wolt.example.com/authorize` (just that path) with a policy allowing your email. Note its Audience tag. Do this *before* the hostname exists, so the approve page is never reachable unguarded.
2. Create a **tunnel**, set its ingress to `wolt.example.com → http://wolt-mcp:3000`, and let it create the DNS record. Copy the connector token.
3. On the server:
   ```
   git clone https://github.com/erlaufer/wolt-mcp.git && cd wolt-mcp/deploy
   cp .env.example .env   # fill in WOLT_PUBLIC_URL, the Access team + AUD, the tunnel token
   docker compose up -d --build
   ```
4. Connect a Wolt account: run `npx -y wolt-mcp login` on your computer and paste the printed refresh token on the approve page when you connect your first client (that gives the grant its own account), or copy `~/.wolt-mcp/tokens.json` into the `wolt-data` volume to give the server a default account that grants without a paste share.

Check it: `curl -i https://wolt.example.com/mcp -X POST` should return 401 with a `WWW-Authenticate` header, and an anonymous `curl -i https://wolt.example.com/authorize` should redirect to your `cloudflareaccess.com` login.

### Connecting clients

- **ChatGPT** — Settings → Plugins → Add custom MCP server: URL `https://wolt.example.com/mcp`, authentication **OAuth**. Leave the advanced settings alone (dynamic registration) or enter the static client id and secret you configured.
- **Claude.ai / Claude iPhone app** — Settings → Connectors → Add custom connector with the same URL; the connector syncs to the mobile app.
- **Claude Code** — `claude mcp add --transport http wolt https://wolt.example.com/mcp`, then `/mcp` to authenticate.
- **Anything with a fixed bearer header** — put a `WOLT_API_TOKENS` entry in its `Authorization: Bearer …` header.

## Running without Cloudflare

Any TLS reverse proxy works: terminate HTTPS, forward to `127.0.0.1:3000`, set `WOLT_PUBLIC_URL` to the public origin and `WOLT_OAUTH_APPROVE_SECRET` as the guard. The OAuth endpoints and `/mcp` must stay reachable without a login page in front of them — only `/authorize` may be gated by something else, and then the server must still be able to verify that gate (today that means Cloudflare Access).
