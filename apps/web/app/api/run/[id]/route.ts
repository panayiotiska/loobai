import { NextResponse } from 'next/server';
import { createAnonClientServer } from '@/lib/supabase-server';
import type { NextRequest } from 'next/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = createAnonClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: run, error: runError } = await supabase
    .from('runs')
    .select()
    .eq('id', params.id)
    .single();

  if (runError || !run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const [{ data: formulaVersion }, { data: trades }] = await Promise.all([
    supabase.from('formula_versions').select().eq('run_id', params.id).maybeSingle(),
    supabase.from('trades').select().eq('run_id', params.id),
  ]);

  return NextResponse.json({ run, formulaVersion, trades: trades ?? [] });
}
