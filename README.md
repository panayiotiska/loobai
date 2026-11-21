<p align="center"><img src="docs/assets/hero.svg" alt="Loob.ai" width="100%"></p>

<p align="center">
  <img alt="mode" src="https://img.shields.io/badge/mode-paper%20only-e94560?style=flat-square">
  <img alt="model" src="https://img.shields.io/badge/model-Gemma%204%2026B-0f3460?style=flat-square">
  <img alt="stack" src="https://img.shields.io/badge/stack-TypeScript%20·%20Supabase%20·%20Next.js-16213e?style=flat-square">
  <img alt="cost" src="https://img.shields.io/badge/infra%20cost-$0-7a8fa6?style=flat-square">
</p>

## What it is

Loob wakes up on a schedule, scans crypto perps and prediction markets, opens **paper** trades, and rewrites its own strategy document, [`FORMULA.md`](FORMULA.md). You watch it work in the **Laab Room**, a small walkable lab. No real money moves.

## The loop

<p align="center"><img src="docs/assets/loop.svg" alt="The research loop" width="100%"></p>

## Four setups, each gated by live data

<p align="center"><img src="docs/assets/setups.svg" alt="S1 S2 S3 D setups" width="100%"></p>

The agent names a setup. **Code** checks the market and rejects the trade if the condition isn't true.

## LLM proposes, code disposes

<p align="center"><img src="docs/assets/guardrails.svg" alt="Guardrails and sizing ladder" width="100%"></p>

## Is it self-learning?

**Self-improving, not self-training.** Model weights never change. What changes is the memory the next run reads, and the rules code enforces.

| | |
|---|---|
| ✅ Every closed trade needs a structured postmortem (skill vs luck, lesson) | feeds `FORMULA.md` |
| ✅ Position size is earned from each setup's realized results | code-owned, not LLM-owned |
| ✅ Every formula version is stored and guarded | nothing is ever lost |
| ❌ No fine-tuning, RL, or backtests | the model is the same every run |
| ❌ No confidence-vs-outcome calibration yet | on the roadmap |

## Architecture

<p align="center"><img src="docs/assets/architecture.svg" alt="Architecture" width="100%"></p>

```
packages/shared      Zod schemas, formula guard
packages/db          Supabase client, queries, migrations
packages/agent-core  Gemma tool loop, 24 tools, sizing ladder, runner
apps/agent           research-tick · monitor-tick entry points
apps/web             Laab Room UI + Telegram webhook
```

## Run it

```bash
pnpm install
cp .env.example .env            # Supabase, Gemini key, Telegram
pnpm db:migrate:local
pnpm build
pnpm --filter @loob/agent run research
pnpm --filter @loob/web dev     # Laab Room on :3000
```

Deploy: push to GitHub (Actions runs the agent), connect `apps/web` to Vercel. Env vars and internals live in [`CLAUDE.md`](CLAUDE.md).

## Steer it

Send `/note <text>` on Telegram or in the web UI. Notes are directives and outrank every trading rule. `/resolve <id> <text>` answers questions the agent asks you.

<p align="center"><sub>Research tool, not financial advice. Paper trading only.</sub></p>
