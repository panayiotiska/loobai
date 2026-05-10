'use client';

import { Sign } from './sign';

export type ModalName = 'painting' | 'computer' | 'board' | 'chalkboard' | 'magician' | null;

interface ObjectProps {
  onActivate: (standX: number, standY: number, modal: ModalName) => void;
  pendingCount?: number;
  formulaVersion?: number;
  openTrades?: Array<{ id: string; side: string; instrument_label?: string | null; instrument_id: string; pnl_usd?: number | null }>;
  realizedPnlUsd?: number;
  winRate?: number | null;
}

/* ── FORMULA EASEL ── left side, above river */
export function FormulaEasel({ onActivate, formulaVersion }: ObjectProps) {
  return (
    <div
      style={{ position: 'absolute', left: '18%', top: '58%', cursor: 'pointer', zIndex: 8 }}
      onClick={(e) => { e.stopPropagation(); onActivate(23, 70, 'painting'); }}
      title="Formula — click to view"
    >
      <svg width="70" height="80" viewBox="0 0 70 80" className="pixelated" style={{ display: 'block' }}>
        {/* Easel legs */}
        <line x1="35" y1="60" x2="10" y2="78" stroke="#7a5230" strokeWidth="4" strokeLinecap="round" />
        <line x1="35" y1="60" x2="60" y2="78" stroke="#7a5230" strokeWidth="4" strokeLinecap="round" />
        <line x1="35" y1="65" x2="35" y2="78" stroke="#7a5230" strokeWidth="3" strokeLinecap="round" />
        {/* Cross-brace */}
        <line x1="20" y1="68" x2="50" y2="68" stroke="#7a5230" strokeWidth="2.5" />
        {/* Canvas frame */}
        <rect x="8"  y="4"  width="54" height="58" rx="2" fill="#a07040" />
        <rect x="11" y="7"  width="48" height="52" fill="#f5f0e8" />
        {/* Canvas content */}
        <rect x="13" y="9"  width="44" height="48" fill="#fffff0" />
        {/* Formula title */}
        <rect x="16" y="14" width="32" height="4" rx="1" fill="#c8a020" opacity="0.7" />
        {/* Lines suggesting formula text */}
        <rect x="16" y="22" width="38" height="2" fill="#888" opacity="0.4" />
        <rect x="16" y="27" width="28" height="2" fill="#888" opacity="0.4" />
        <rect x="16" y="32" width="34" height="2" fill="#888" opacity="0.4" />
        <rect x="16" y="37" width="22" height="2" fill="#888" opacity="0.4" />
        <rect x="16" y="42" width="30" height="2" fill="#888" opacity="0.4" />
        {/* Version badge */}
        {formulaVersion != null && (
          <>
            <rect x="38" y="48" width="18" height="8" rx="2" fill="#e94560" />
            <text x="47" y="54" textAnchor="middle" fill="white" fontSize="5" fontFamily="monospace" fontWeight="bold">
              v{formulaVersion}
            </text>
          </>
        )}
        {/* Hover glow border */}
        <rect x="8" y="4" width="54" height="58" rx="2" fill="none" stroke="#ffd700" strokeWidth="1.5" opacity="0.5" />
      </svg>
      <Sign label="FORMULA" dx={72} dy={20} />
    </div>
  );
}

/* ── BULLETIN BOARD ── right side, above river */
export function BulletinBoard({ onActivate, pendingCount = 0, realizedPnlUsd, winRate }: ObjectProps) {
  const pnlSign = realizedPnlUsd != null && realizedPnlUsd >= 0 ? '+' : realizedPnlUsd != null ? '-' : '';
  const pnlAbs = realizedPnlUsd != null ? Math.abs(realizedPnlUsd) : null;
  const pnlText =
    pnlAbs == null ? null
      : pnlAbs >= 1000 ? `${pnlSign}$${(pnlAbs / 1000).toFixed(1)}k`
      : `${pnlSign}$${pnlAbs.toFixed(0)}`;
  const pnlColor = realizedPnlUsd != null && realizedPnlUsd >= 0 ? '#1e8a3a' : '#a8312a';

  return (
    <div
      style={{ position: 'absolute', left: '63%', top: '58%', cursor: 'pointer', zIndex: 8 }}
      onClick={(e) => { e.stopPropagation(); onActivate(66, 70, 'board'); }}
      title={pnlText ? `Board — PnL ${pnlText}` : 'Board — click to view'}
    >
      <svg width="72" height="88" viewBox="0 0 72 88" className="pixelated" style={{ display: 'block' }}>
        {/* Post */}
        <rect x="34" y="60" width="4" height="28" fill="#6b3f1a" />
        {/* Board backing */}
        <rect x="4"  y="4"  width="64" height="58" rx="3" fill="#7a4a1a" />
        <rect x="6"  y="6"  width="60" height="54" rx="2" fill="#c8893a" />
        {/* Cork texture */}
        <rect x="8"  y="8"  width="56" height="50" rx="1" fill="#d4a460" />
        {/* Pinned notes */}
        <rect x="12" y="12" width="22" height="16" rx="1" fill="#fffde0" transform="rotate(-3 12 12)" />
        <circle cx="23" cy="13" r="2" fill="#e94560" />
        <rect x="38" y="10" width="18" height="14" rx="1" fill="#e0f0ff" transform="rotate(2 38 10)" />
        <circle cx="47" cy="11" r="2" fill="#3a7bd5" />
        {/* PnL pinned note (replaces lower-left green note) */}
        <g transform="rotate(1 14 34)">
          <rect x="11" y="33" width="24" height="14" rx="1" fill="#fffef0" stroke="#5a3a1a" strokeWidth="0.4" />
          <circle cx="23" cy="35" r="2" fill="#2eb82e" />
          <text x="23" y="41" textAnchor="middle" fontSize="5" fontFamily="monospace" fontWeight="bold" fill="#444">PnL</text>
          <text x="23" y="46.5" textAnchor="middle" fontSize="5.5" fontFamily="monospace" fontWeight="bold" fill={pnlColor}>
            {pnlText ?? '—'}
          </text>
        </g>
        {/* Win-rate pinned note (replaces lower-right orange note) */}
        <g transform="rotate(-2 38 32)">
          <rect x="37" y="31" width="24" height="18" rx="1" fill="#fff0e0" stroke="#5a3a1a" strokeWidth="0.4" />
          <circle cx="49" cy="33" r="2" fill="#e9a020" />
          <text x="49" y="40" textAnchor="middle" fontSize="4.5" fontFamily="monospace" fill="#666">WIN RATE</text>
          <text x="49" y="46.5" textAnchor="middle" fontSize="7" fontFamily="monospace" fontWeight="bold" fill="#4a3010">
            {winRate != null ? `${Math.round(winRate * 100)}%` : '—'}
          </text>
        </g>
        {/* Pending badge */}
        {pendingCount > 0 && (
          <>
            <circle cx="60" cy="8" r="9" fill="#e94560" />
            <text x="60" y="12" textAnchor="middle" fill="white" fontSize="8" fontFamily="monospace" fontWeight="bold">
              {pendingCount}
            </text>
          </>
        )}
      </svg>
      <Sign label="BOARD" dx={8} dy={86} />
    </div>
  );
}

/* ── DESK + COMPUTER ── right side, below river */
export function DeskComputer({ onActivate }: ObjectProps) {
  return (
    <div
      style={{ position: 'absolute', left: '53%', top: '73%', cursor: 'pointer', zIndex: 8 }}
      onClick={(e) => { e.stopPropagation(); onActivate(60, 82, 'computer'); }}
      title="Computer — leave a note"
    >
      <svg width="88" height="72" viewBox="0 0 88 72" className="pixelated" style={{ display: 'block' }}>
        {/* Desk surface */}
        <rect x="0"  y="38" width="88" height="10" rx="2" fill="#a07040" />
        <rect x="2"  y="40" width="84" height="6"  rx="1" fill="#c8a060" />
        {/* Desk legs */}
        <rect x="4"  y="48" width="8"  height="24" rx="1" fill="#7a5230" />
        <rect x="76" y="48" width="8"  height="24" rx="1" fill="#7a5230" />
        {/* Monitor stand */}
        <rect x="38" y="28" width="12" height="12" rx="1" fill="#555" />
        <rect x="32" y="35" width="24" height="5"  rx="1" fill="#444" />
        {/* Monitor body */}
        <rect x="14" y="4"  width="60" height="38" rx="3" fill="#333" />
        <rect x="16" y="6"  width="56" height="34" rx="2" fill="#1a2a4a" />
        {/* Screen glow */}
        <rect x="17" y="7"  width="54" height="32" rx="1" fill="#0d1f3a" />
        {/* Screen content — code lines */}
        <rect x="20" y="12" width="30" height="2" fill="#3a7bd5" opacity="0.8" />
        <rect x="20" y="17" width="42" height="2" fill="#2eb82e" opacity="0.7" />
        <rect x="20" y="22" width="24" height="2" fill="#e94560" opacity="0.8" />
        <rect x="20" y="27" width="36" height="2" fill="#3a7bd5" opacity="0.7" />
        <rect x="20" y="32" width="18" height="2" fill="#c8a020" opacity="0.8" />
        {/* Cursor blink */}
        <rect x="38" y="32" width="3" height="2" fill="#c8d8e8" opacity="0.9" />
        {/* Keyboard */}
        <rect x="18" y="42" width="52" height="8"  rx="1" fill="#555" />
        <rect x="20" y="43" width="48" height="6"  rx="1" fill="#444" />
        {[0,1,2,3,4,5,6,7,8,9,10,11].map(i => (
          <rect key={i} x={22 + i * 4} y={44} width="3" height="4" rx="0.5" fill="#666" />
        ))}
      </svg>
      <Sign label="NOTES" dx={16} dy={70} />
    </div>
  );
}

/* ── CHALKBOARD (paper positions) ── left side, below river */
export function Chalkboard({ onActivate, openTrades = [] }: ObjectProps) {
  const total = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  return (
    <div
      style={{ position: 'absolute', left: '27%', top: '77%', cursor: 'pointer', zIndex: 8 }}
      onClick={(e) => { e.stopPropagation(); onActivate(32, 88, 'chalkboard'); }}
      title="Positions — click to view"
    >
      <svg width="80" height="90" viewBox="0 0 80 90" className="pixelated" style={{ display: 'block' }}>
        {/* Legs */}
        <rect x="10" y="64" width="5" height="26" rx="1" fill="#5a3a1a" />
        <rect x="65" y="64" width="5" height="26" rx="1" fill="#5a3a1a" />
        {/* Cross-bar */}
        <rect x="10" y="72" width="60" height="3" rx="1" fill="#5a3a1a" />
        {/* Board */}
        <rect x="2"  y="2"  width="76" height="66" rx="3" fill="#1a4a1a" />
        <rect x="4"  y="4"  width="72" height="62" rx="2" fill="#1e5c1e" />
        {/* Chalk lines suggesting trades */}
        <rect x="10" y="14" width="60" height="2" rx="1" fill="rgba(255,255,255,0.7)" />
        {openTrades.slice(0, 5).map((t, i) => (
          <g key={t.id}>
            <rect x="8" y={22 + i * 8} width={t.side === 'buy' ? 20 : 18} height="2" rx="1" fill="rgba(200,220,255,0.65)" />
            <rect x={52} y={22 + i * 8} width={22} height="2" rx="1"
              fill={t.pnl_usd != null && t.pnl_usd >= 0 ? 'rgba(100,255,100,0.7)' : 'rgba(255,100,100,0.7)'} />
          </g>
        ))}
        {openTrades.length === 0 && (
          <text x="40" y="38" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6" fontFamily="monospace">no positions</text>
        )}
        {/* Total line */}
        <rect x="8" y="62" width="64" height="1" rx="0" fill="rgba(255,255,255,0.4)" />
        {/* Chalk tray */}
        <rect x="4" y="64" width="72" height="4" rx="1" fill="#3a2a10" />
        <rect x="8" y="65" width="8"  height="2" fill="white" opacity="0.7" />
        <rect x="18" y="65" width="6" height="2" fill="#ffff80" opacity="0.7" />
      </svg>
      <Sign label="POSITIONS" dx={-104} dy={20} />
    </div>
  );
}

/* ── MAGICIAN ── bottom-right */
export function Magician({ onActivate }: ObjectProps) {
  return (
    <div
      style={{ position: 'absolute', left: '38%', top: '80%', cursor: 'pointer', zIndex: 8 }}
      onClick={(e) => { e.stopPropagation(); onActivate(43, 91, 'magician'); }}
      title="Magician — talk to him"
    >
      <svg width="52" height="80" viewBox="0 0 52 80" className="pixelated" style={{ display: 'block' }}>
        {/* Ground shadow */}
        <ellipse cx="26" cy="78" rx="10" ry="3" fill="rgba(0,0,0,0.2)" />
        {/* Robe / body */}
        <polygon points="14,70 18,30 34,30 38,70" fill="#5b2d8e" />
        <polygon points="14,70 18,30 26,34 26,70" fill="#6b35aa" />
        {/* Robe hem detail */}
        <polygon points="12,70 14,70 38,70 40,70 42,74 10,74" fill="#4a2075" />
        {/* Stars on robe */}
        <polygon points="22,45 23,42 24,45 21,43 25,43" fill="#ffd700" opacity="0.8" />
        <polygon points="29,55 30,52 31,55 28,53 32,53" fill="#ffd700" opacity="0.7" />
        {/* Arms + sleeves */}
        <rect x="6"  y="32" width="14" height="8" rx="3" fill="#5b2d8e" />
        <rect x="32" y="32" width="14" height="8" rx="3" fill="#5b2d8e" />
        {/* Hands */}
        <ellipse cx="10" cy="42" rx="4" ry="3" fill="#f5c5a3" />
        <ellipse cx="42" cy="42" rx="4" ry="3" fill="#f5c5a3" />
        {/* Wand in right hand */}
        <line x1="44" y1="40" x2="50" y2="24" stroke="#2c1810" strokeWidth="2" strokeLinecap="round" />
        <circle cx="50" cy="23" r="3" fill="#ffd700" />
        <circle cx="50" cy="23" r="1.5" fill="white" opacity="0.7" />
        {/* Wand sparkle */}
        <circle cx="50" cy="18" r="1" fill="#ffd700" opacity="0.6" />
        <circle cx="54" cy="22" r="0.8" fill="#ffd700" opacity="0.5" />
        <circle cx="46" cy="20" r="0.8" fill="#ffd700" opacity="0.5" />
        {/* Head / face */}
        <ellipse cx="26" cy="22" rx="8" ry="9" fill="#f5c5a3" />
        {/* Long white beard */}
        <ellipse cx="26" cy="30" rx="7" ry="5" fill="white" />
        <rect   x="20" y="30" width="12" height="14" rx="3" fill="white" />
        <ellipse cx="26" cy="44" rx="5"  ry="3" fill="white" />
        {/* Beard wisps */}
        <rect x="21" y="44" width="2" height="6" rx="1" fill="white" />
        <rect x="26" y="44" width="2" height="8" rx="1" fill="white" />
        <rect x="31" y="44" width="2" height="5" rx="1" fill="white" />
        {/* Eyes */}
        <ellipse cx="22" cy="21" rx="2" ry="2" fill="white" />
        <ellipse cx="30" cy="21" rx="2" ry="2" fill="white" />
        <circle  cx="23" cy="21" r="1" fill="#1a0a5a" />
        <circle  cx="31" cy="21" r="1" fill="#1a0a5a" />
        {/* Eyebrows — bushy */}
        <rect x="19" y="17" width="7" height="2" rx="1" fill="#c8c8c8" />
        <rect x="26" y="17" width="7" height="2" rx="1" fill="#c8c8c8" />
        {/* Triangle wizard hat */}
        <polygon points="26,0 12,20 40,20" fill="#4a1a80" />
        <polygon points="26,0 18,14 26,14" fill="#5b2d8e" />
        {/* Hat brim */}
        <rect x="9" y="18" width="34" height="5" rx="1" fill="#3a0f6a" />
        {/* Hat star */}
        <polygon points="26,4 27,7 30,7 28,9 29,12 26,10 23,12 24,9 22,7 25,7" fill="#ffd700" opacity="0.9" />
        {/* Hat band */}
        <rect x="9" y="18" width="34" height="2" fill="#ffd700" opacity="0.4" />
      </svg>
      <Sign label="WIZARD" dx={56} dy={11} />
    </div>
  );
}
