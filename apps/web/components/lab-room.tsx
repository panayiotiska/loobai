'use client';

import { useState, useRef, useCallback } from 'react';
import { PaintingModal } from './painting';
import { ComputerModal } from './computer-modal';
import { Character } from './game/character';
import type { Direction } from './game/character';
import { NatureLayer } from './game/nature';
import {
  FormulaEasel,
  BulletinBoard,
  DeskComputer,
  Chalkboard,
  Magician,
} from './game/objects';
import type { ModalName } from './game/objects';
import type { FormulaVersion, Trade, AgentRequest, PortfolioStats } from '@loob/db';
import { PortfolioPanel } from './portfolio-visuals';

interface LabRoomProps {
  latestFormula: FormulaVersion | null;
  formulaVersions: FormulaVersion[];
  openTrades: Trade[];
  pendingRequests: AgentRequest[];
  portfolioStats: PortfolioStats;
}

export function LabRoom({
  latestFormula,
  formulaVersions,
  openTrades,
  pendingRequests,
  portfolioStats,
}: LabRoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Character state
  const [charPos,    setCharPos]    = useState({ x: 44, y: 48 });
  const [charTarget, setCharTarget] = useState({ x: 44, y: 48 });
  const [facing,     setFacing]     = useState<Direction>('down');
  const [isWalking,  setIsWalking]  = useState(false);

  // Click ripples
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const rippleId = useRef(0);

  // Modal state
  const [openModal,    setOpenModal]    = useState<ModalName>(null);
  const [pendingModal, setPendingModal] = useState<ModalName>(null);

  const moveTo = useCallback((tx: number, ty: number) => {
    setCharPos(prev => {
      const dx = tx - prev.x;
      const dy = ty - prev.y;
      if (Math.abs(dx) > Math.abs(dy)) {
        setFacing(dx > 0 ? 'right' : 'left');
      } else {
        setFacing(dy > 0 ? 'down' : 'up');
      }
      return prev;
    });
    setCharTarget({ x: tx, y: ty });
    setIsWalking(true);
  }, []);

  const handleWorldClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || openModal !== null) return;
    const rect = containerRef.current.getBoundingClientRect();
    const tx = ((e.clientX - rect.left) / rect.width)  * 100;
    const ty = ((e.clientY - rect.top)  / rect.height) * 100;

    // Spawn ripple at cursor position
    const id = ++rippleId.current;
    setRipples(prev => [...prev, { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 600);

    setPendingModal(null);
    moveTo(tx, ty);
  }, [moveTo, openModal]);

  const handleObjectClick = useCallback((standX: number, standY: number, modal: ModalName) => {
    setPendingModal(modal);
    moveTo(standX, standY);
  }, [moveTo]);

  const handleTransitionEnd = useCallback(() => {
    setCharPos(charTarget);
    setIsWalking(false);
    if (pendingModal) {
      setOpenModal(pendingModal);
      setPendingModal(null);
    }
  }, [charTarget, pendingModal]);

  const totalPnl = openTrades.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);

  return (
    <div
      ref={containerRef}
      className="relative w-screen h-screen overflow-hidden select-none"
      style={{ cursor: 'crosshair', background: '#1a3a1a' }}
      onClick={handleWorldClick}
    >
      {/* ── Grass ground ── */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'repeating-conic-gradient(#2a5c2a 0% 25%, #2e6b2e 0% 50%)',
          backgroundSize: '32px 32px',
          zIndex: 0,
        }}
      />

      {/* ── Nature layer (river, trees, bridge, butterflies) ── */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}>
        <NatureLayer />
      </div>

      {/* ── Interactive world objects ── */}
      <FormulaEasel
        onActivate={handleObjectClick}
        formulaVersion={latestFormula?.version}
      />
      <BulletinBoard
        onActivate={handleObjectClick}
        pendingCount={pendingRequests.length}
        realizedPnlUsd={portfolioStats.realizedPnlUsd}
        winRate={portfolioStats.winRate}
      />
      <DeskComputer onActivate={handleObjectClick} />
      <Chalkboard
        onActivate={handleObjectClick}
        openTrades={openTrades.map(t => ({
          id: t.id,
          side: t.side,
          instrument_label: t.instrument_label,
          instrument_id: t.instrument_id,
          pnl_usd: t.pnl_usd,
        }))}
      />
      <Magician onActivate={handleObjectClick} />

      {/* ── Walking character ── */}
      <Character
        x={charTarget.x}
        y={charTarget.y}
        facing={facing}
        isWalking={isWalking}
        onTransitionEnd={handleTransitionEnd}
      />

      {/* ── Modals ── */}
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

      {/* Board modal */}
      {openModal === 'board' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setOpenModal(null)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative bg-lab-wall border border-lab-dim rounded-lg shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpenModal(null)}
              className="absolute top-4 right-4 text-lab-dim hover:text-lab-text"
            >
              ✕
            </button>
            <h2 className="text-lab-glow font-bold text-lg mb-3">Performance</h2>
            <PortfolioPanel stats={portfolioStats} />

            <h2 className="text-lab-glow font-bold text-lg mb-3 mt-6">Pending requests</h2>
            {pendingRequests.length === 0 ? (
              <p className="text-lab-dim text-sm">No pending requests from Loob.</p>
            ) : (
              <div className="space-y-3">
                {pendingRequests.map((r) => (
                  <div key={r.id} className="bg-lab-accent/30 border border-lab-dim/30 rounded p-3 text-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="bg-lab-glow/20 text-lab-glow text-xs px-1.5 py-0.5 rounded">{r.kind}</span>
                      <span className="text-lab-dim text-xs">{r.id.slice(0, 8)}</span>
                    </div>
                    <p className="text-lab-text mb-1">{r.prompt}</p>
                    {r.context && <p className="text-lab-dim text-xs">{r.context}</p>}
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

      {/* Chalkboard / positions modal */}
      {openModal === 'chalkboard' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setOpenModal(null)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative bg-[#1e5c1e] border-4 border-[#1a4a1a] rounded-lg shadow-2xl w-full max-w-sm p-6 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpenModal(null)}
              className="absolute top-3 right-3 text-white/50 hover:text-white text-lg"
            >
              ✕
            </button>
            <h2 className="text-white font-bold text-lg mb-4 font-mono tracking-wide">
              📊 Paper Positions
            </h2>
            {openTrades.length === 0 ? (
              <p className="text-white/60 text-sm font-mono">No open positions.</p>
            ) : (
              <div className="space-y-2 font-mono text-sm">
                {openTrades.map((t) => (
                  <div key={t.id} className="flex justify-between text-white/90">
                    <span className="truncate max-w-[60%]">
                      {t.side.toUpperCase()} {t.instrument_label ?? t.instrument_id}
                    </span>
                    <span className={(t.pnl_usd ?? 0) >= 0 ? 'text-green-300' : 'text-red-300'}>
                      {t.pnl_usd != null
                        ? `${t.pnl_usd >= 0 ? '+' : ''}$${t.pnl_usd.toFixed(2)}`
                        : 'open'}
                    </span>
                  </div>
                ))}
                <div className="pt-2 border-t border-white/20 text-white/70 font-bold">
                  Total:{' '}
                  <span className={totalPnl >= 0 ? 'text-green-300' : 'text-red-300'}>
                    {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Magician modal */}
      {openModal === 'magician' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setOpenModal(null)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative bg-[#2a0a50] border-4 border-[#ffd700]/50 rounded-lg shadow-2xl w-full max-w-sm p-6 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpenModal(null)}
              className="absolute top-3 right-3 text-yellow-300/50 hover:text-yellow-300 text-lg"
            >
              ✕
            </button>
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">🧙</div>
              <h2 className="text-yellow-300 font-bold text-lg font-mono">The Wizard speaks…</h2>
            </div>
            <p className="text-purple-200 text-sm font-mono text-center leading-relaxed">
              "My powers are gathering… return soon and I shall reveal the secrets of Settings & Analytics."
            </p>
            <p className="text-purple-400/60 text-xs font-mono text-center mt-4">
              — Coming soon —
            </p>
          </div>
        </div>
      )}

      {/* ── Click ripples ── */}
      {ripples.map(r => (
        <div
          key={r.id}
          style={{
            position: 'absolute',
            left: r.x,
            top: r.y,
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.7)',
            animation: 'click-ripple 0.6s ease-out forwards',
            pointerEvents: 'none',
            zIndex: 50,
          }}
        />
      ))}

      {/* ── HUD: tiny hint ── */}
      <div
        style={{ position: 'absolute', bottom: 12, right: 16, zIndex: 30, pointerEvents: 'none' }}
        className="text-white/30 text-[10px] font-mono"
      >
        click to walk · click objects to interact
      </div>
    </div>
  );
}
