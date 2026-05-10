import { NextResponse } from 'next/server';
import { createAnonClientServer } from '@/lib/supabase-server';
import { insertNote } from '@loob/db';
import { z } from 'zod';

const NoteSchema = z.object({
  content: z.string().min(1).max(4000),
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

  const parsed = NoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const note = await insertNote(supabase as any, 'web', parsed.data.content);
    return NextResponse.json({ note });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
