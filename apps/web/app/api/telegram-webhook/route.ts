import { NextResponse } from 'next/server';
import { createServiceClientEdge } from '@/lib/supabase-edge';
import { insertNote, resolveAgentRequest, setPausedState, getSystemState } from '@loob/db';
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
