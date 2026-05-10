import { NextResponse } from 'next/server';
import { createAnonClientServer } from '@/lib/supabase-server';
import { resolveAgentRequest } from '@loob/db';
import { z } from 'zod';

const ResolveSchema = z.object({
  id: z.string().uuid(),
  resolution: z.string().min(1).max(4000),
});

export async function POST(request: Request) {
  const supabase = createAnonClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveAgentRequest(supabase as any, parsed.data.id, parsed.data.resolution);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
