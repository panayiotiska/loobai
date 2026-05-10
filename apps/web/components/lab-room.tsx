'use client';

import { useState } from 'react';
import { PaintingModal } from './painting';
import { ComputerModal } from './computer-modal';
import type { FormulaVersion, Trade, AgentRequest } from '@loob/db';

interface LabRoomProps {
  latestFormula: FormulaVersion | null;
  formulaVersions: FormulaVersion[];
  openTrades: Trade[];
  pendingRequests: AgentRequest[];
}

type ModalName = 'painting' | 'computer' | 'board' | null;

export function LabRoom({
  latestFormula,
  formulaVersions,
  openTrades,
  pendingRequests,
}: LabRoomProps) {
  const [openModal, setOpenModal] = useState<ModalName>(null);

  const totalPnl = openTrades.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);
  const pnlStr = totalPnl >= 0
    ? `+$${totalPnl.toFixed(2)}`
    : `-$${Math.abs(totalPnl).toFixed(2)}`;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-lab-bg select-none">
      {/* Room background — placeholder until pixel art is commissioned */}
      <div className="absolute inset-0 flex flex-col">
        {/* Wall */}
        <div className="h-[45%] bg-lab-wall border-b-4 border-lab-floor" />
        {/* Floor */}
        <div className="flex-1 bg-lab-floor" />
      </div>

      {/* ── PAINTING (wall, left-center) ── */}
      <button
        onClick={() => setOpenModal('painting')}
        className="absolute top-[8%] left-[12%] w-[20%] h-[28%] border-4 border-yellow-700/60 bg-lab-accent/80 hover:border-yellow-500 hover:bg-lab-accent transition-colors group flex flex-col items-center justify-center gap-1"
        aria-label="View FORMULA — Loob's strategy document"
      >
        <span className="text-lab-dim group-hover:text-lab-text text-xs font-bold tracking-widest uppercase">FORMULA</span>
        {latestFormula && (
          <span className="text-lab-glow text-xs">v{latestFormula.version}</span>
        )}
        <span className="text-lab-dim/60 text-[10px]">click to view</span>
      </button>

      {/* ── COMPUTER (wall, right) ── */}
      <button
        onClick={() => setOpenModal('computer')}
        className="absolute top-[25%] right-[15%] w-[16%] h-[20%] border-4 border-lab-dim/40 bg-lab-accent/60 hover:border-lab-glow hover:bg-lab-accent transition-colors group flex flex-col items-center justify-center gap-1"
        aria-label="Leave a note for Loob"
      >
        <span className="text-2xl">🖥️</span>
        <span className="text-lab-dim group-hover:text-lab-text text-xs font-bold uppercase tracking-wider">Note</span>
        <span className="text-lab-dim/60 text-[10px]">leave a message</span>
      </button>

      {/* ── BULLETIN BOARD (wall, right-center) ── */}
      <button
        onClick={() => setOpenModal('board')}
        className="absolute top-[6%] right-[35%] w-[14%] h-[22%] border-4 border-orange-700/50 bg-orange-950/50 hover:border-orange-500 hover:bg-orange-900/40 transition-colors group flex flex-col items-center justify-center gap-1"
        aria-label="View pending requests and run history"
      >
        <span className="text-lab-dim group-hover:text-lab-text text-xs font-bold uppercase tracking-wider">Board</span>
        {pendingRequests.length > 0 && (
          <span className="bg-lab-glow text-white text-[10px] px-1.5 py-0.5 rounded-full">
            {pendingRequests.length} pending
          </span>
        )}
        <span className="text-lab-dim/60 text-[10px]">requests</span>
      </button>

      {/* ── TV / TICKER (floor, left) ── */}
      <div className="absolute bottom-[12%] left-[8%] w-[30%] h-[20%] bg-lab-accent/40 border-4 border-lab-dim/30 flex flex-col p-3">
        <div className="text-lab-glow text-[10px] font-bold tracking-widest mb-2 uppercase">
          Paper positions
        </div>
        {openTrades.length === 0 ? (
          <p className="text-lab-dim text-xs">No open positions.</p>
        ) : (
          <div className="overflow-y-auto space-y-1 text-xs">
            {openTrades.map((t) => (
              <div key={t.id} className="flex justify-between text-lab-text">
                <span className="truncate max-w-[60%]">
                  {t.side.toUpperCase()} {t.instrument_label ?? t.instrument_id}
                </span>
                <span className={(t.pnl_usd ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {t.pnl_usd != null
                    ? `${t.pnl_usd >= 0 ? '+' : ''}$${t.pnl_usd.toFixed(2)}`
                    : 'open'}
                </span>
              </div>
            ))}
            <div className="pt-1 border-t border-lab-dim/20 text-lab-dim font-bold">
              Total: <span className={(totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>{pnlStr}</span>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      <PaintingModal
        isOpen={openModal === 'painting'}
        onClose={() => setOpenModal(null)}
        formula={latestFormula}
        versions={formulaVersions}
      />

      <ComputerModal
        isOpen={openModal === 'computer'}
        onClose={() => setOpenModal(null)}
      />

      {/* Inline board modal */}
      {openModal === 'board' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setOpenModal(null)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative bg-lab-wall border border-lab-dim rounded-lg shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-6 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpenModal(null)}
              className="absolute top-4 right-4 text-lab-dim hover:text-lab-text"
              aria-label="Close"
            >
              ✕
            </button>
            <h2 className="text-lab-glow font-bold text-lg mb-4">Pending requests</h2>
            {pendingRequests.length === 0 ? (
              <p className="text-lab-dim text-sm">No pending requests from Loob.</p>
            ) : (
              <div className="space-y-3">
                {pendingRequests.map((r) => (
                  <div key={r.id} className="bg-lab-accent/30 border border-lab-dim/30 rounded p-3 text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="bg-lab-glow/20 text-lab-glow text-xs px-1.5 py-0.5 rounded">
                        {r.kind}
                      </span>
                      <span className="text-lab-dim text-xs">{r.id.slice(0, 8)}</span>
                    </div>
                    <p className="text-lab-text mb-1">{r.prompt}</p>
                    {r.context && (
                      <p className="text-lab-dim text-xs">{r.context}</p>
                    )}
                    <p className="text-lab-dim/60 text-xs mt-2">
                      Reply on Telegram: <code>/resolve {r.id.slice(0, 8)} your answer</code>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
