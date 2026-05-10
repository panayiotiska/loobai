# Loob.ai — Developer Guide for Claude

## What this project is

Loob.ai is an autonomous AI trading research agent. It runs on a cron schedule (GitHub Actions), reads a living strategy document (`FORMULA.md`), researches markets via Gemini + free APIs, paper-trades, and updates the strategy. Everything surfaces in a Next.js "Laab Room" UI. Real-money execution is explicitly disabled in v1.

**The agent's job:** Every 4 hours, read the current formula, call tools to research markets, open/close paper trades, write a new formula version, send a Telegram summary.

---

## Monorepo structure

```
packages/shared        — Zod schemas (RunOutputSchema), shared types, Result<T,E>
packages/db            — Supabase client, typed query helpers, migration SQL
packages/agent-core    — Gemini loop, tools, system prompt, runner, Telegram
apps/agent             — Entry points (research-tick.ts, monitor-tick.ts) via tsx
apps/web               — Next.js 14 App Router, Supabase auth, Laab Room UI
```

**Dependency graph:** `shared` ← `db` ← `agent-core` ← `agent`. `web` depends on `db` and `shared` directly.

---

## Key technical decisions

- **No Database generic on SupabaseClient** — all DB functions use `SupabaseClient<any>` with explicit return type casts (e.g. `return data as Run`). Do not add the Database generic back — it causes `never` type resolution issues with the Supabase JS client.
- **Manual Gemini tool loop** — `gemini-loop.ts` manually iterates tool calls rather than using the SDK's auto loop. Max 12 iterations for research, 4 for monitor. Retries 503/429 with backoff.
- **Telegram outbound via raw fetch** — no SDK. One POST to `api.telegram.org`.
- **ESM everywhere** — `"type": "module"` in all package.jsons. Use `.js` extensions in imports even for `.ts` files.
- **pino for logging** — structured JSON. Use `log.info({ msg: '...', ...context })` not `log.info('...')`.
- **Result<T,E> pattern** — tool handlers return `{ ok: true, data }` or `{ ok: false, error }`. Import `ok()` and `err()` from `@loob/shared`.

---

## Running locally

```bash
# Install
pnpm install

# Run DB migration (first time only)
pnpm db:migrate:local

# Run agent (loads root .env automatically)
pnpm --filter @loob/agent run research
pnpm --filter @loob/agent run monitor

# Run web UI
pnpm --filter @loob/web dev

# Build all packages
pnpm build
```

Local env vars live in `.env` at the repo root. The web app also needs `apps/web/.env.local` (same values, Next.js only reads from the app directory).

---

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | agent, web | Project URL |
| `SUPABASE_ANON_KEY` | web | RLS-enforced, safe for browser |
| `SUPABASE_SERVICE_ROLE_KEY` | agent only | Never expose in web bundle |
| `NEXT_PUBLIC_SUPABASE_URL` | web | Same as SUPABASE_URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Same as SUPABASE_ANON_KEY |
| `DATABASE_URL` | migration only | Session pooler URI from Supabase Connect panel |
| `GEMINI_API_KEY` | agent | Gemini 2.5 Flash |
| `TELEGRAM_BOT_TOKEN` | agent, web | From @BotFather |
| `TELEGRAM_CHAT_ID` | agent | Your personal Telegram user ID |
| `TELEGRAM_USER_ID` | web webhook | Same as CHAT_ID — authorizes inbound messages |
| `TELEGRAM_WEBHOOK_SECRET` | web webhook | Random string, set when registering webhook |
| `PUBLIC_WEB_URL` | agent | Vercel URL, used in Telegram summary links |
| `NEXT_PUBLIC_ALLOWED_USER_EMAIL` | web | Only this email can sign in |

---

## Database schema

Five tables in `packages/db/migrations/0001_init.sql`:

| Table | Purpose |
|---|---|
| `runs` | One row per agent tick. Tracks status, token usage, formula version written. |
| `formula_versions` | Append-only log of FORMULA.md snapshots. Version is an incrementing integer. |
| `notes` | User notes from web or Telegram. Consumed by agent on next run. |
| `trades` | Paper (and future live) trades. `mode='paper'` always in v1. |
| `agent_requests` | Agent asks user a question. User resolves via web UI or `/resolve` on Telegram. |

All tables have RLS enabled. Agent uses service role key (bypasses RLS). Web uses anon key (subject to RLS).

Query helpers are in `packages/db/src/queries.ts` — always use these, never write raw Supabase queries elsewhere.

---

## Adding a new agent tool

1. Add the tool handler function in `packages/agent-core/src/tools/` (or add to an existing file if closely related)
2. Register the `FunctionDeclaration` in `buildToolDeclarations()` in `packages/agent-core/src/tools/index.ts` — use `Type.STRING`, `Type.NUMBER`, `Type.OBJECT` from `@google/genai`
3. Register the handler in `buildToolHandlers()` in the same file
4. Return `{ ok: true, data: ... }` or `{ ok: false, error: '...' }` — never throw
5. Update the system prompt in `packages/agent-core/src/prompts/system.ts` to mention the new tool
6. Rebuild: `pnpm --filter @loob/agent-core build`
7. Test locally: `pnpm --filter @loob/agent run research`

---

## Modifying the agent's behaviour

The agent's personality, rules, and output contract are defined in `packages/agent-core/src/prompts/system.ts` (`buildSystemPrompt`). Key sections:
- **Epistemic rules** — confidence scores required, no hallucinating sources
- **FORMULA.md management** — when to update, what format to use
- **Output contract** — must end response with a ` ```json ``` ` block matching `RunOutputSchema`

`RunOutputSchema` is in `packages/shared/src/schemas.ts`. If you add fields to the schema, update both the Zod schema and the system prompt.

---

## Deploying changes

```bash
# After any changes to agent-core, db, or shared:
pnpm build

# Push to GitHub — Vercel auto-deploys web, GitHub Actions picks up workflow changes
git add -A && git commit -m "your message" && git push
```

GitHub Actions workflows are in `.github/workflows/`. They build packages before running the agent:
```
pnpm --filter @loob/shared build && pnpm --filter @loob/db build && pnpm --filter @loob/agent-core build
```

If you add a new workspace package that `agent-core` depends on, add it to this build chain.

---

## Telegram

**Outbound** (agent → you): `packages/agent-core/src/telegram.ts` — `sendTelegramSummary()` and `sendTelegramError()`.

**Inbound** (you → agent): `apps/web/app/api/telegram-webhook/route.ts`
- `/note <text>` — inserts a note the agent reads on next run
- `/resolve <uuid> <text>` — resolves a pending agent request
- Webhook registered with: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<VERCEL_URL>/api/telegram-webhook?secret=<SECRET>"`

---

## Web UI

**Auth:** Supabase magic link. Only `NEXT_PUBLIC_ALLOWED_USER_EMAIL` can sign in. Auth callback at `/auth/callback`.

**Supabase clients:**
- Server components / API routes: `createAnonClientServer()` from `apps/web/lib/supabase-server.ts`
- Edge API routes (telegram webhook): `createServiceClientEdge()` from `apps/web/lib/supabase-edge.ts`
- Client components: `createBrowserClient()` from `@supabase/ssr` directly

**Casting pattern** — when passing Supabase client to `@loob/db` functions, cast as `any`:
```ts
const db = supabase as any;
await insertNote(db, 'web', text);
```

**Tailwind theme** — custom colours defined in `apps/web/tailwind.config.ts`:
- `lab-bg` — dark background
- `lab-accent` — card/panel background
- `lab-glow` — primary red accent
- `lab-dim` — muted text
- `lab-text` — primary text

---

## Common pitfalls

- **Always rebuild after editing `packages/`** — `apps/agent` and `apps/web` import from `dist/`, not `src/`. Running `pnpm build` (or per-package `pnpm --filter @loob/agent-core build`) is required for changes to take effect.
- **`.env` is root-level, not in `apps/`** — local agent scripts use `dotenv -e ../../.env` to load it. The web app uses `apps/web/.env.local`.
- **Supabase magic link rate limit** — 3 emails/hour on free tier. Don't spam the login button.
- **Gemini 503s are transient** — the loop retries up to 3 times with 15s/30s backoff. If it keeps failing, Gemini is overloaded; try again later.
- **`NEXT_PUBLIC_` prefix required** — env vars used in client components must be prefixed `NEXT_PUBLIC_`. Server-only vars (service role key) must NOT have this prefix.
