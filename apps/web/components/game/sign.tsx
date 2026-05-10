interface SignProps {
  label: string;
  /** offset from parent object's top-left, in px */
  dx?: number;
  dy?: number;
}

export function Sign({ label, dx = 0, dy = 0 }: SignProps) {
  return (
    <svg
      width="100"
      height="72"
      viewBox="0 0 100 72"
      className="pixelated pointer-events-none"
      style={{ position: 'absolute', left: dx, top: dy }}
    >
      {/* Post */}
      <rect x="47" y="48" width="6" height="24" fill="#7a5230" />
      {/* Sign board */}
      <rect x="2"  y="4"  width="96" height="46" rx="3" fill="#a0672a" />
      <rect x="5"  y="7"  width="90" height="40" rx="2" fill="#c8893a" />
      {/* Border nails */}
      <rect x="6"  y="8"  width="5" height="5" fill="#8b6914" />
      <rect x="89" y="8"  width="5" height="5" fill="#8b6914" />
      <rect x="6"  y="40" width="5" height="5" fill="#8b6914" />
      <rect x="89" y="40" width="5" height="5" fill="#8b6914" />
      {/* Text */}
      <foreignObject x="5" y="10" width="90" height="32">
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '13px',
            fontWeight: 'bold',
            color: '#3b1f00',
            textAlign: 'center',
            lineHeight: '32px',
            letterSpacing: '1px',
            userSelect: 'none',
          }}
        >
          {label}
        </div>
      </foreignObject>
    </svg>
  );
}
