import { LabRoom } from '@/components/lab-room';
import { createAnonClientServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { getAllFormulaVersions, getOpenTrades, getPendingRequests } from '@loob/db';

export default async function LabRoomPage() {
  const supabase = createAnonClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const [formulaVersions, openTrades, pendingRequests] = await Promise.all([
    getAllFormulaVersions(db),
    getOpenTrades(db),
    getPendingRequests(db),
  ]);

  const latestFormula = formulaVersions[0] ?? null;

  return (
    <LabRoom
      latestFormula={latestFormula}
      formulaVersions={formulaVersions}
      openTrades={openTrades}
      pendingRequests={pendingRequests}
    />
  );
}
