'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { FormulaViewer } from './formula-viewer';
import type { FormulaVersion } from '@loob/db';

interface PaintingModalProps {
  isOpen: boolean;
  onClose: () => void;
  formula: FormulaVersion | null;
  versions: FormulaVersion[];
}

export function PaintingModal({ isOpen, onClose, formula, versions }: PaintingModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/70"
            onClick={onClose}
          />
          <motion.div
            className="relative bg-lab-wall border border-lab-dim rounded-lg shadow-2xl w-full max-w-2xl h-[80vh] flex flex-col p-6 z-10"
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-lab-dim hover:text-lab-text transition-colors"
              aria-label="Close"
            >
              ✕
            </button>

            {formula ? (
              <FormulaViewer formula={formula} versions={versions} />
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-lab-dim">No formula yet. Run the agent to establish v1.</p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
