import type { RunOutput } from '@loob/shared';
import type { Trade } from '@loob/db';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// Escape characters Telegram's HTML parser treats as markup. Apply to ALL
// agent-emitted fields so summaries containing "< $72k" or "&" don't 400.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    log.warn({ msg: 'Telegram not configured — skipping notification' });
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    log.error({ msg: 'Telegram send failed', status: res.status, body });
  }
}

export interface TelegramSummaryInput {
  runId: string;
  runKind: string;
  output: RunOutput;
  openTrades: Trade[];
  pendingRequestCount: number;
}

export async function sendTelegramSummary(input: TelegramSummaryInput): Promise<void> {
  const { runId, runKind, output, openTrades, pendingRequestCount } = input;
  const webUrl = process.env.PUBLIC_WEB_URL ?? '';

  const totalPnl = openTrades.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);
  const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  const confidencePct = (output.confidenceInThesis * 100).toFixed(0);

  let message = `🧪 <b>Loob run</b> — ${escapeHtml(runKind)} — ✅\n`;
  message += `<code>${escapeHtml(runId.slice(0, 8))}</code>\n\n`;
  message += `${escapeHtml(output.summary)}\n\n`;
  message += `📈 Open paper positions: ${openTrades.length} (${pnlStr})\n`;
  message += `📊 Confidence in thesis: ${confidencePct}%\n`;
  message += `🎯 Next run focus: ${escapeHtml(output.nextRunFocus)}`;

  if (webUrl) {
    message += `\n\n🔗 ${webUrl}/runs/${runId}`;
  }

  if (pendingRequestCount > 0) {
    message += `\n\n❓ <b>Loob is asking for input</b> (${pendingRequestCount} pending)\nReply with: <code>/resolve &lt;id&gt; &lt;your answer&gt;</code>`;
  }

  await sendTelegramMessage(message);
}

export async function sendTelegramError(
  runId: string,
  error: unknown,
  opts?: { consecutiveFailures?: number },
): Promise<void> {
  const banner =
    opts?.consecutiveFailures && opts.consecutiveFailures >= 3
      ? `⚠️ <b>${opts.consecutiveFailures + 1}th consecutive failure of this kind</b>\n`
      : '';
  const message =
    banner +
    `🚨 <b>Loob run failed</b>\n` +
    `<code>${runId.slice(0, 8)}</code>\n\n` +
    `<code>${escapeHtml(String(error).slice(0, 500))}</code>`;
  await sendTelegramMessage(message);
}
