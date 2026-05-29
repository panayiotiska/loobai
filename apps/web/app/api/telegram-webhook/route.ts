import { NextResponse } from 'next/server';
import { createServiceClientEdge } from '@/lib/supabase-edge';
import {
  insertNote,
  resolveAgentRequest,
  setPausedState,
  getSystemState,
  getPortfolioStats,
  getOpenTrades,
  getClosedTradesWithPostmortems,
  getLatestFormula,
} from '@loob/db';
import type { NextRequest } from 'next/server';

interface TelegramUpdate {
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
  };
}

async function sendReply(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const message = update.message;
  if (!message?.text) return NextResponse.json({ ok: true });

  const allowedUserId = parseInt(process.env.TELEGRAM_USER_ID ?? '0', 10);
  if (message.from?.id !== allowedUserId) {
    return NextResponse.json({ ok: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceClientEdge() as any;
  const text = message.text.trim();
  const chatId = message.chat.id;

  const resolveMatch = text.match(/^\/resolve\s+([a-f0-9-]{36})\s+([\s\S]+)$/i);
  if (resolveMatch) {
    const [, id, resolution] = resolveMatch;
    try {
      await resolveAgentRequest(db, id, resolution);
      await sendReply(chatId, `✅ Resolved request ${id.slice(0, 8)}`);
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  const pauseMatch = text.match(/^\/pause(?:\s+([\s\S]+))?$/i);
  if (pauseMatch) {
    const reason = pauseMatch[1]?.trim() || 'manual';
    try {
      const state = await setPausedState(db, { paused: true, reason, by: 'telegram' });
      await sendReply(chatId, `🛑 Agent paused — ${state.paused_reason ?? reason}`);
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === '/resume') {
    try {
      await setPausedState(db, { paused: false, reason: null, by: 'telegram' });
      await sendReply(chatId, '▶️ Agent resumed.');
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === '/help') {
    await sendReply(
      chatId,
      [
        'Loob commands:',
        '/pnl — portfolio stats (realized + unrealized PnL, win rate, exposure)',
        '/positions (or /open) — current open paper trades',
        '/trades [N] — last N closed trades + lessons (default 5, max 20)',
        '/regime — current regime + watchlist from FORMULA.md',
        '/status — paused/running',
        '/pause [reason] — pause the agent',
        '/resume — resume the agent',
        '/note <text> — drop a note Loob reads next run',
        '/resolve <uuid> <text> — resolve a pending agent request',
        '/help — this list',
      ].join('\n'),
    );
    return NextResponse.json({ ok: true });
  }

  if (text === '/pnl') {
    try {
      const s = await getPortfolioStats(db);
      const winRatePct = s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : 'n/a';
      const fmt = (n: number | null) => (n == null ? 'n/a' : `$${n.toFixed(2)}`);
      await sendReply(
        chatId,
        [
          '📊 Portfolio',
          `Realized PnL: $${s.realizedPnlUsd.toFixed(2)} (30d: $${s.realizedPnlLast30dUsd.toFixed(2)})`,
          `Unrealized PnL: $${s.openUnrealizedPnlUsd.toFixed(2)} on ${s.openCount} open ($${s.openExposureUsd.toFixed(2)} exposure)`,
          `Win rate: ${winRatePct}  (${s.wins}W / ${s.losses}L of ${s.closedCount} closed)`,
          `Best: ${fmt(s.biggestWinUsd)}  Worst: ${fmt(s.biggestLossUsd)}`,
          `Avg win: ${fmt(s.avgWinUsd)}  Avg loss: ${fmt(s.avgLossUsd)}`,
        ].join('\n'),
      );
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === '/positions' || text === '/open') {
    try {
      const trades = await getOpenTrades(db);
      if (trades.length === 0) {
        await sendReply(chatId, 'No open positions.');
      } else {
        const lines = trades.map((t) => {
          const label = t.instrument_label ?? t.instrument_id;
          const sz = (t as { size_class?: string }).size_class ?? 'conviction';
          const pnl = t.pnl_usd != null ? `PnL $${t.pnl_usd.toFixed(2)}` : 'PnL —';
          const inv = t.invalidation_signal ?? '(no invalidation set)';
          return `• [${sz}] ${label} ${t.side.toUpperCase()} $${t.size_usd} @ ${t.entry_price} | ${pnl}\n  thesis: ${t.thesis.slice(0, 140)}\n  invalidation: ${inv.slice(0, 140)}`;
        });
        await sendReply(chatId, `📈 ${trades.length} open\n${lines.join('\n')}`.slice(0, 4000));
      }
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  const tradesMatch = text.match(/^\/trades(?:\s+(\d+))?$/i);
  if (tradesMatch) {
    try {
      const n = Math.min(Math.max(parseInt(tradesMatch[1] ?? '5', 10) || 5, 1), 20);
      const closed = await getClosedTradesWithPostmortems(db, n);
      if (closed.length === 0) {
        await sendReply(chatId, 'No closed trades yet.');
      } else {
        const lines = closed.map((t) => {
          const label = t.instrument_label ?? t.instrument_id;
          const pnl = t.pnl_usd ?? 0;
          const tag = pnl >= 0 ? '✅' : '❌';
          const lesson = t.postmortem?.lesson ?? '(no postmortem)';
          return `${tag} ${label} ${t.side.toUpperCase()} | PnL $${pnl.toFixed(2)}\n  lesson: ${lesson.slice(0, 200)}`;
        });
        await sendReply(chatId, `📜 last ${closed.length}\n${lines.join('\n')}`.slice(0, 4000));
      }
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === '/regime') {
    try {
      const f = await getLatestFormula(db);
      if (!f) {
        await sendReply(chatId, 'No FORMULA version yet.');
      } else {
        const md = f.content;
        const grab = (header: string): string => {
          const m = md.match(new RegExp(`##\\s*${header}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n#\\s|$)`, 'i'));
          return m ? m[1].trim() : '(empty)';
        };
        const regime = grab('Current regime');
        const watch = grab('Watchlist');
        await sendReply(
          chatId,
          [`🎯 FORMULA v${f.version}`, '', 'Regime:', regime.slice(0, 800), '', 'Watchlist:', watch.slice(0, 1500)].join('\n').slice(0, 4000),
        );
      }
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  if (text === '/status') {
    try {
      const state = await getSystemState(db);
      const msg = state.paused
        ? `🛑 Paused since ${state.paused_at ?? '?'} — ${state.paused_reason ?? 'manual'}`
        : '▶️ Running.';
      await sendReply(chatId, msg);
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
    return NextResponse.json({ ok: true });
  }

  const noteText = text.startsWith('/note ') ? text.slice(6) : text;
  if (noteText) {
    try {
      await insertNote(db, 'telegram', noteText);
      await sendReply(chatId, '✅ Noted — Loob will see this on the next run.');
    } catch (e) {
      await sendReply(chatId, `❌ Error: ${String(e).slice(0, 200)}`);
    }
  }

  return NextResponse.json({ ok: true });
}
