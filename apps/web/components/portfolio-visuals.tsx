'use client';

import type { PortfolioStats } from '@loob/db';

const fmtUsd = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const pnlColor = (n: number) => (n >= 0 ? 'text-green-400' : 'text-red-400');

interface Props {
  stats: PortfolioStats;
}

export function PortfolioPanel({ stats }: Props) {
  const exposureCap = 10_000;
  const exposurePct = Math.min(100, (stats.openExposureUsd / exposureCap) * 100);

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2 font-mono">
        <Stat label="Realized PnL" value={fmtUsd(stats.realizedPnlUsd)} valueClass={pnlColor(stats.realizedPnlUsd)} />
        <Stat label="Unrealized" value={fmtUsd(stats.openUnrealizedPnlUsd)} valueClass={pnlColor(stats.openUnrealizedPnlUsd)} />
        <Stat
          label="Win rate"
          value={stats.winRate != null ? `${(stats.winRate * 100).toFixed(0)}%` : '—'}
          sub={`${stats.wins}W / ${stats.losses}L`}
        />
        <Stat
          label="Open / Closed"
          value={`${stats.openCount} / ${stats.closedCount}`}
        />
        <Stat
          label="Biggest win"
          value={stats.biggestWinUsd != null ? fmtUsd(stats.biggestWinUsd) : '—'}
          valueClass="text-green-400"
        />
        <Stat
          label="Biggest loss"
          value={stats.biggestLossUsd != null ? fmtUsd(stats.biggestLossUsd) : '—'}
          valueClass="text-red-400"
        />
      </div>

      <div className="font-mono text-xs">
        <div className="flex justify-between mb-1 text-lab-dim">
          <span>Open exposure</span>
          <span>${stats.openExposureUsd.toFixed(0)} / ${exposureCap.toLocaleString()}</span>
        </div>
        <div className="h-1.5 bg-black/40 rounded overflow-hidden">
          <div
            className={`h-full rounded transition-all ${exposurePct > 80 ? 'bg-red-500' : exposurePct > 50 ? 'bg-yellow-500' : 'bg-green-500'}`}
            style={{ width: `${exposurePct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
        <PnlSparkline curve={stats.pnlCurve} />
        <WinLossDonut wins={stats.wins} losses={stats.losses} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-black/20 rounded px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-lab-dim">{label}</div>
      <div className={`text-sm font-semibold ${valueClass ?? 'text-lab-text'}`}>{value}</div>
      {sub && <div className="text-[10px] text-lab-dim">{sub}</div>}
    </div>
  );
}

function PnlSparkline({ curve }: { curve: PortfolioStats['pnlCurve'] }) {
  const W = 180;
  const H = 60;
  if (curve.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-lab-dim font-mono bg-black/20 rounded"
        style={{ width: W, height: H }}
      >
        Need ≥2 closed trades
      </div>
    );
  }

  const ys = curve.map((p) => p.cumulativePnlUsd);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const range = max - min || 1;

  const points = curve.map((p, i) => {
    const x = (i / (curve.length - 1)) * (W - 4) + 2;
    const y = H - 2 - ((p.cumulativePnlUsd - min) / range) * (H - 4);
    return [x, y] as const;
  });

  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = ys[ys.length - 1];
  const stroke = last >= 0 ? '#4ade80' : '#f87171';
  const fillId = last >= 0 ? 'sparkfill-pos' : 'sparkfill-neg';
  const fillColor = last >= 0 ? '#4ade80' : '#f87171';

  // Zero line position
  const zeroY = H - 2 - ((0 - min) / range) * (H - 4);

  return (
    <svg width={W} height={H} className="bg-black/20 rounded">
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillColor} stopOpacity="0.35" />
          <stop offset="100%" stopColor={fillColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="2" y1={zeroY} x2={W - 2} y2={zeroY} stroke="#888" strokeWidth="0.5" strokeDasharray="2,2" opacity="0.5" />
      <path d={`${path} L${points[points.length - 1][0]},${H} L${points[0][0]},${H} Z`} fill={`url(#${fillId})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" />
      <circle cx={points[points.length - 1][0]} cy={points[points.length - 1][1]} r="2" fill={stroke} />
      <text x={W - 4} y={11} textAnchor="end" fontSize="9" fontFamily="monospace" fill={stroke}>
        cum PnL
      </text>
    </svg>
  );
}

function WinLossDonut({ wins, losses }: { wins: number; losses: number }) {
  const SIZE = 60;
  const R = 22;
  const C = 2 * Math.PI * R;
  const total = wins + losses;

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-lab-dim font-mono bg-black/20 rounded"
        style={{ width: SIZE, height: SIZE }}
      >
        —
      </div>
    );
  }

  const winFrac = wins / total;
  const winRate = Math.round(winFrac * 100);

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#f87171" strokeWidth="6" />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        fill="none"
        stroke="#4ade80"
        strokeWidth="6"
        strokeDasharray={`${winFrac * C} ${C}`}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
      <text
        x={SIZE / 2}
        y={SIZE / 2 + 4}
        textAnchor="middle"
        fontSize="13"
        fontFamily="monospace"
        fontWeight="bold"
        fill={winFrac >= 0.5 ? '#4ade80' : '#f87171'}
      >
        {winRate}%
      </text>
    </svg>
  );
}
