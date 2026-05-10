'use client';

import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import type { FormulaVersion } from '@loob/db';

interface FormulaViewerProps {
  formula: FormulaVersion;
  versions: FormulaVersion[];
  compact?: boolean;
}

export function FormulaViewer({ formula, versions, compact = false }: FormulaViewerProps) {
  const router = useRouter();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lab-glow font-bold text-lg">
          FORMULA v{formula.version}
        </h2>
        <select
          value={formula.version}
          onChange={(e) => router.push(`/formula/${e.target.value}`)}
          className="bg-lab-bg border border-lab-dim text-lab-text text-sm px-2 py-1 rounded focus:outline-none focus:border-lab-glow"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.version}>
              v{v.version} — {v.created_at.slice(0, 10)}
            </option>
          ))}
        </select>
      </div>

      {formula.changelog && (
        <div className="mb-4 text-xs text-lab-dim bg-lab-accent/30 border border-lab-dim/30 rounded px-3 py-2">
          📝 {formula.changelog}
        </div>
      )}

      <div
        className={`overflow-y-auto flex-1 ${compact ? 'text-sm' : 'text-base'} prose prose-invert prose-sm max-w-none`}
        style={{
          '--tw-prose-body': '#c8d8e8',
          '--tw-prose-headings': '#e94560',
          '--tw-prose-code': '#7a8fa6',
          '--tw-prose-pre-bg': '#16213e',
        } as React.CSSProperties}
      >
        <ReactMarkdown>{formula.content}</ReactMarkdown>
      </div>
    </div>
  );
}
