'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';

interface ComputerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ComputerModal({ isOpen, onClose }: ComputerModalProps) {
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;

    setStatus('sending');
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: note }),
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus('sent');
      setNote('');
      setTimeout(() => {
        setStatus('idle');
        onClose();
      }, 1500);
    } catch {
      setStatus('error');
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/70" onClick={onClose} />
          <motion.div
            className="relative bg-lab-wall border border-lab-dim rounded-lg shadow-2xl w-full max-w-md p-6 z-10"
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

            <h2 className="text-lab-glow font-bold text-lg mb-1">Leave a note</h2>
            <p className="text-lab-dim text-sm mb-4">
              Loob will read this on the next research run.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Focus on prediction markets this week. Ignore BTC volatility — I think it's noise."
                rows={5}
                maxLength={4000}
                className="w-full bg-lab-bg border border-lab-dim text-lab-text text-sm px-3 py-2 rounded focus:outline-none focus:border-lab-glow resize-none"
              />
              <div className="flex items-center justify-between">
                <span className="text-lab-dim text-xs">{note.length}/4000</span>
                <button
                  type="submit"
                  disabled={status === 'sending' || !note.trim()}
                  className="bg-lab-glow text-white px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {status === 'sending' ? 'Sending…' : status === 'sent' ? '✅ Sent!' : 'Send note'}
                </button>
              </div>
              {status === 'error' && (
                <p className="text-red-400 text-xs">Failed to send. Try again.</p>
              )}
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
