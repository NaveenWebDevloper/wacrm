import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { id } = await params;

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const admin = supabaseAdmin();
    const { data: series, error: fetchError } = await admin
      .from('broadcast_series')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (fetchError || !series) {
      return NextResponse.json({ error: 'Recurring broadcast series not found' }, { status: 404 });
    }

    if (series.status === 'cancelled' || series.status === 'completed') {
      return NextResponse.json({ error: `Series is already ${series.status}` }, { status: 400 });
    }

    const { error: updError } = await admin
      .from('broadcast_series')
      .update({
        status: 'cancelled',
        next_run_at: null,
      })
      .eq('id', id);

    if (updError) {
      return NextResponse.json({ error: `Failed to cancel series: ${updError.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Error in cancel endpoint:', err);
    return NextResponse.json({ error: 'Failed to process cancel request' }, { status: 500 });
  }
}
