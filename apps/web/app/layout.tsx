import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loob.ai — Laab Room',
  description: 'Autonomous trading research agent',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-lab-bg min-h-screen">{children}</body>
    </html>
  );
}
