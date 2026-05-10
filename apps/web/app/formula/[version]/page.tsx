import { createAnonClientServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { getFormulaVersion, getAllFormulaVersions } from '@loob/db';
import { FormulaViewer } from '@/components/formula-viewer';

export default async function FormulaVersionPage({
  params,
}: {
  params: { version: string };
}) {
  const supabase = createAnonClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const version = parseInt(params.version, 10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const [formula, allVersions] = await Promise.all([
    getFormulaVersion(db, version),
    getAllFormulaVersions(db),
  ]);

  if (!formula) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-lab-bg">
        <p className="text-lab-dim">Formula version {version} not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-lab-bg p-8">
      <FormulaViewer formula={formula} versions={allVersions} />
    </div>
  );
}
