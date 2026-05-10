'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const allowed = process.env.NEXT_PUBLIC_ALLOWED_USER_EMAIL;
    if (allowed && email !== allowed) {
      setError('Lab is closed to visitors.');
      return;
    }

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    if (authError) {
      setError(authError.message);
    } else {
      setSent(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-lab-bg">
      <div className="bg-lab-accent border border-lab-dim p-8 rounded max-w-sm w-full">
        <h1 className="text-lab-glow text-2xl font-bold mb-2">🧪 Loob.ai</h1>
        <p className="text-lab-dim text-sm mb-6">Laab Room access</p>

        {sent ? (
          <p className="text-lab-text">
            ✅ Magic link sent to <strong>{email}</strong>. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full bg-lab-bg border border-lab-dim text-lab-text px-3 py-2 rounded focus:outline-none focus:border-lab-glow"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              className="w-full bg-lab-glow text-white py-2 rounded hover:opacity-90 transition-opacity"
            >
              Send magic link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
