export type Direction = 'up' | 'down' | 'left' | 'right';

interface CharacterProps {
  x: number; // % of container width
  y: number; // % of container height
  facing: Direction;
  isWalking: boolean;
  onTransitionEnd: () => void;
}

// Pixel art character top-down view — 20×24px logical, rendered at 2.5× scale (50×60px)
function CharacterSVG({ facing }: { facing: Direction }) {
  // Shadow direction dot positions
  const shadowOffsets: Record<Direction, [number, number]> = {
    down:  [9, 18],
    up:    [9, 4],
    left:  [2, 11],
    right: [15, 11],
  };
  const [sx, sy] = shadowOffsets[facing];

  return (
    <svg
      width="50"
      height="60"
      viewBox="0 0 20 24"
      className="pixelated"
      style={{ display: 'block' }}
    >
      {/* Ground shadow */}
      <ellipse cx="10" cy="22" rx="5" ry="2" fill="rgba(0,0,0,0.18)" />

      {/* Body / torso */}
      <rect x="6" y="10" width="8" height="8" rx="1" fill="#3a7bd5" />
      {/* Arms */}
      <rect x="3" y="11" width="3" height="5" rx="1" fill="#3a7bd5" />
      <rect x="14" y="11" width="3" height="5" rx="1" fill="#3a7bd5" />
      {/* Legs */}
      <rect x="6" y="17" width="3" height="4" rx="1" fill="#1a1a5e" />
      <rect x="11" y="17" width="3" height="4" rx="1" fill="#1a1a5e" />
      {/* Shoes */}
      <rect x="5" y="20" width="4" height="2" rx="1" fill="#2c1810" />
      <rect x="11" y="20" width="4" height="2" rx="1" fill="#2c1810" />

      {/* Head */}
      <ellipse cx="10" cy="8" rx="5" ry="5" fill="#f5c5a3" />
      {/* Hair */}
      <rect x="5" y="3" width="10" height="3" rx="1" fill="#4a2800" />
      {/* Eyes — shift with facing */}
      {facing === 'down' && (
        <>
          <rect x="7"  y="8" width="2" height="2" fill="#1a0a00" />
          <rect x="11" y="8" width="2" height="2" fill="#1a0a00" />
        </>
      )}
      {facing === 'up' && (
        <rect x="7" y="5" width="6" height="1" fill="#4a2800" />
      )}
      {facing === 'left' && (
        <rect x="6" y="8" width="2" height="2" fill="#1a0a00" />
      )}
      {facing === 'right' && (
        <rect x="12" y="8" width="2" height="2" fill="#1a0a00" />
      )}

      {/* Direction indicator dot (subtle) */}
      <circle cx={sx} cy={sy} r="1.2" fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

export function Character({ x, y, facing, isWalking, onTransitionEnd }: CharacterProps) {
  return (
    <div
      onTransitionEnd={onTransitionEnd}
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: 'translate(-50%, -50%)',
        transition: 'left 0.45s linear, top 0.45s linear',
        zIndex: 20,
        pointerEvents: 'none',
      }}
    >
      <div className={isWalking ? 'animate-walk-bob' : ''}>
        <CharacterSVG facing={facing} />
      </div>
    </div>
  );
}
