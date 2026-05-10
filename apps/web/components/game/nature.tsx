/* ── Nature decorations — trees, river, bridge, butterflies ── */

function Tree({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const s = size;
  return (
    <div style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 5 }}>
      <svg width={44 * s} height={52 * s} viewBox="0 0 44 52" className="pixelated">
        <rect x="18" y="36" width="8" height="16" fill="#6b3f1a" />
        <rect x="20" y="38" width="3" height="12" fill="#8b5a2b" />
        <ellipse cx="22" cy="26" rx="18" ry="14" fill="#1a6b1a" />
        <ellipse cx="22" cy="20" rx="14" ry="12" fill="#228b22" />
        <ellipse cx="22" cy="15" rx="10" ry="9"  fill="#2eb82e" />
        <ellipse cx="18" cy="13" rx="4" ry="3" fill="#3dcc3d" opacity="0.6" />
      </svg>
    </div>
  );
}

export function River() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: '22%',
        height: '12%',
        zIndex: 2,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        className="animate-river-flow"
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'repeating-linear-gradient(90deg, #1a6b9a 0px, #1e7db5 8px, #2592cc 16px, #1a6b9a 24px, #1560a0 32px, #1a6b9a 40px, #1e7db5 48px, #2592cc 56px, #1a6b9a 64px)',
          backgroundSize: '64px 100%',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'repeating-linear-gradient(180deg, rgba(255,255,255,0.06) 0px, transparent 4px, transparent 8px)',
        }}
      />
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: '#2d7a2d' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 4, background: '#2d7a2d' }} />
    </div>
  );
}

export function Bridge() {
  // Narrow footbridge crossing the river top-to-bottom.
  // Planks are horizontal boards stacked vertically (perpendicular to river flow).
  // Both side rails arc the same direction (gentle rightward bow).
  const plankYs = Array.from({ length: 14 }, (_, i) => 2 + i * 6);
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '22%',
        width: '6%',
        height: '12%',
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 36 80" preserveAspectRatio="none">
        {/* Planks — horizontal boards, stacked top to bottom */}
        {plankYs.map((py, i) => (
          <rect key={py} x="3" y={py} width="26" height="4" rx="0.5"
            fill={i % 2 === 0 ? '#b08850' : '#a07040'}
            stroke="#7a5230" strokeWidth="0.5"
          />
        ))}
        {/* Left rail — arcs right */}
        <path d="M 3,0 Q 10,40 3,80" fill="none" stroke="#6b3f1a" strokeWidth="3" strokeLinecap="round" />
        {/* Right rail — same rightward arc */}
        <path d="M 29,0 Q 36,40 29,80" fill="none" stroke="#6b3f1a" strokeWidth="3" strokeLinecap="round" />
        {/* Rope texture on rails */}
        <path d="M 3,0 Q 10,40 3,80" fill="none" stroke="#a07040" strokeWidth="1" strokeDasharray="3 3" />
        <path d="M 29,0 Q 36,40 29,80" fill="none" stroke="#a07040" strokeWidth="1" strokeDasharray="3 3" />
      </svg>
    </div>
  );
}

function Butterfly({ className, style }: { className: string; style?: React.CSSProperties }) {
  return (
    <div
      className={className}
      style={{ position: 'absolute', pointerEvents: 'none', zIndex: 25, ...style }}
    >
      <svg width="20" height="16" viewBox="0 0 20 16" className="pixelated">
        <ellipse cx="6"  cy="6"  rx="5" ry="4" fill="#ff9900" opacity="0.9" className="animate-wing-flap" style={{ transformOrigin: '10px 8px' }} />
        <ellipse cx="5"  cy="11" rx="4" ry="3" fill="#ff6600" opacity="0.8" className="animate-wing-flap" style={{ transformOrigin: '10px 8px', animationDelay: '0.05s' }} />
        <ellipse cx="14" cy="6"  rx="5" ry="4" fill="#ff9900" opacity="0.9" className="animate-wing-flap" style={{ transformOrigin: '10px 8px', transform: 'scaleX(-1)' }} />
        <ellipse cx="15" cy="11" rx="4" ry="3" fill="#ff6600" opacity="0.8" className="animate-wing-flap" style={{ transformOrigin: '10px 8px', transform: 'scaleX(-1)', animationDelay: '0.05s' }} />
        <ellipse cx="10" cy="8" rx="1.5" ry="5" fill="#1a0a00" />
        <line x1="10" y1="3" x2="7"  y2="0" stroke="#1a0a00" strokeWidth="0.8" />
        <line x1="10" y1="3" x2="13" y2="0" stroke="#1a0a00" strokeWidth="0.8" />
        <circle cx="7"  cy="0" r="1" fill="#1a0a00" />
        <circle cx="13" cy="0" r="1" fill="#1a0a00" />
      </svg>
    </div>
  );
}

export function RockWall() {
  const stone: React.CSSProperties = {
    position: 'absolute',
    height: 22,
    background: '#7e7e7e',
    backgroundImage: [
      'repeating-linear-gradient(90deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 22px)',
      'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 11px)',
    ].join(','),
    backgroundSize: '22px 11px',
    boxShadow: '0 4px 6px rgba(0,0,0,0.35), inset 0 -2px 0 rgba(0,0,0,0.25)',
    zIndex: 7,
    pointerEvents: 'none',
  };
  const stoneV: React.CSSProperties = {
    ...stone,
    height: undefined,
    width: 22,
    backgroundSize: '11px 22px',
  };
  const corner: React.CSSProperties = {
    position: 'absolute',
    width: 22,
    height: 22,
    background: '#6a6a6a',
    boxShadow: '0 4px 6px rgba(0,0,0,0.35)',
    zIndex: 8,
    pointerEvents: 'none',
  };

  // Enclosure at bottom of screen — door gap on TOP wall (43%–53%)
  // Left: 15%  Right: 72%  Top: 52%  Bottom: 3%
  return (
    <>
      {/* Top-left wall segment (door gap: 43%–53%) */}
      <div style={{ ...stone, left: '15%', right: '57%', top: '52%' }} />
      {/* Top-right wall segment */}
      <div style={{ ...stone, left: '53%', right: '28%', top: '52%' }} />
      {/* Left wall */}
      <div style={{ ...stoneV, left: '15%', top: '52%', bottom: '3%' }} />
      {/* Right wall */}
      <div style={{ ...stoneV, right: '28%', top: '52%', bottom: '3%' }} />
      {/* Bottom wall — solid, no gap */}
      <div style={{ ...stone, left: '15%', right: '28%', bottom: '3%' }} />

      {/* Corner caps */}
      <div style={{ ...corner, left: '15%', top: '52%' }} />
      <div style={{ ...corner, right: '28%', top: '52%' }} />
      <div style={{ ...corner, left: '15%', bottom: '3%' }} />
      <div style={{ ...corner, right: '28%', bottom: '3%' }} />

      {/* THE LAAB — banner above the door */}
      <div style={{
        position: 'absolute',
        left: '37%',
        top: 'calc(52% - 44px)',
        transform: 'translateX(-50%)',
        zIndex: 9,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
        {/* Banner board */}
        <div style={{
          background: '#a07040',
          border: '3px solid #6b3f1a',
          boxShadow: '0 3px 8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15)',
          padding: '4px 18px',
          whiteSpace: 'nowrap',
        }}>
          <span style={{
            fontFamily: 'monospace',
            fontWeight: 'bold',
            fontSize: '15px',
            color: '#fff8e0',
            letterSpacing: '4px',
            textShadow: '0 1px 3px rgba(0,0,0,0.6)',
          }}>
            THE LAAB
          </span>
        </div>
        {/* Two small chains/posts hanging down to wall */}
        <div style={{ display: 'flex', gap: 40 }}>
          <div style={{ width: 3, height: 10, background: '#6b3f1a' }} />
          <div style={{ width: 3, height: 10, background: '#6b3f1a' }} />
        </div>
      </div>
    </>
  );
}

function InfoBoard() {
  return (
    <div style={{
      position: 'absolute',
      right: '2%',
      top: '62%',
      width: 320,
      pointerEvents: 'none',
      zIndex: 6,
    }}>
      <svg width="320" height="280" viewBox="0 0 160 140" className="pixelated">
        {/* Legs */}
        <rect x="28" y="118" width="7" height="22" rx="1" fill="#6b3f1a" />
        <rect x="125" y="118" width="7" height="22" rx="1" fill="#6b3f1a" />
        {/* Board shadow */}
        <rect x="4" y="7" width="152" height="114" rx="3" fill="rgba(0,0,0,0.18)" />
        {/* Board backing */}
        <rect x="2" y="4" width="152" height="114" rx="3" fill="#7a5230" />
        {/* Board face */}
        <rect x="5" y="7" width="146" height="108" rx="2" fill="#c8a060" />
        {/* Plank lines */}
        <line x1="5" y1="43" x2="151" y2="43" stroke="#a07840" strokeWidth="1.5" />
        <line x1="5" y1="79" x2="151" y2="79" stroke="#a07840" strokeWidth="1.5" />
        {/* Wood grain */}
        <line x1="20" y1="7"  x2="18"  y2="115" stroke="rgba(0,0,0,0.06)" strokeWidth="2" />
        <line x1="55" y1="7"  x2="53"  y2="115" stroke="rgba(0,0,0,0.05)" strokeWidth="1.5" />
        <line x1="90" y1="7"  x2="88"  y2="115" stroke="rgba(0,0,0,0.06)" strokeWidth="2" />
        <line x1="125" y1="7" x2="123" y2="115" stroke="rgba(0,0,0,0.05)" strokeWidth="1.5" />
        {/* Corner nails */}
        <circle cx="12"  cy="16"  r="3" fill="#8b6914" />
        <circle cx="148" cy="16"  r="3" fill="#8b6914" />
        <circle cx="12"  cy="106" r="3" fill="#8b6914" />
        <circle cx="148" cy="106" r="3" fill="#8b6914" />
        {/* Frame border */}
        <rect x="2" y="4" width="152" height="114" rx="3" fill="none" stroke="#5a3a10" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function NatureLayer() {
  return (
    <>
      <River />
      <Bridge />
      <RockWall />
      <InfoBoard />

      {/* Trees — top edge */}
      <Tree x={3}  y={8}  size={1.6} />
      <Tree x={10} y={6}  size={1.4} />
      <Tree x={18} y={9}  size={1.2} />
      <Tree x={26} y={7}  size={1.5} />
      <Tree x={34} y={8}  size={1.3} />
      <Tree x={57} y={7}  size={1.4} />
      <Tree x={65} y={9}  size={1.2} />
      <Tree x={73} y={6}  size={1.5} />
      <Tree x={81} y={8}  size={1.3} />
      <Tree x={89} y={7}  size={1.6} />
      <Tree x={96} y={9}  size={1.4} />

      {/* Trees — left edge (above room) */}
      <Tree x={3}  y={42} size={1.4} />
      <Tree x={4}  y={56} size={1.3} />

      {/* Trees — right edge (above room) */}
      <Tree x={97} y={42} size={1.4} />
      <Tree x={96} y={56} size={1.3} />

      {/* Scattered trees outside room */}
      <Tree x={85} y={50} size={1.2} />
      <Tree x={8}  y={62} size={1.1} />

      {/* Butterflies */}
      <Butterfly className="animate-butterfly-1" style={{ left: '70%', top: '52%' }} />
      <Butterfly className="animate-butterfly-2" style={{ left: '82%', top: '48%' }} />
      <Butterfly className="animate-butterfly-3" style={{ left: '76%', top: '38%' }} />
    </>
  );
}
