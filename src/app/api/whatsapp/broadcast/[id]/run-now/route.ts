import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { executeBroadcast } from '@/lib/broadcasts/broadcast-sender';

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

    // Increment execution count for this ad-hoc execution
    const currentExecCount = series.execution_count + 1;
    const { error: updError } = await admin
      .from('broadcast_series')
      .update({
        execution_count: currentExecCount,
      })
      .eq('id', id);

    if (updError) {
      return NextResponse.json({ error: `Failed to update series execution count: ${updError.message}` }, { status: 500 });
    }

    // Spawn child broadcast
    const { data: childBroadcast, error: childError } = await admin
      .from('broadcasts')
      .insert({
        account_id: series.account_id,
        user_id: series.user_id,
        name: `${series.name} (Ad-hoc Run #${currentExecCount})`,
        template_name: series.template_name,
        template_language: series.template_language,
        template_variables: series.template_variables,
        audience_filter: series.audience_filter,
        parent_series_id: series.id,
        status: 'sending',
        total_recipients: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      })
      .select()
      .single();

    if (childError || !childBroadcast) {
      return NextResponse.json({ error: `Failed to spawn ad-hoc run: ${childError?.message}` }, { status: 500 });
    }

    // Run the execution loop in the background so the HTTP request returns quickly
    // Next.js runtime supports letting microtasks complete.
    executeBroadcast(childBroadcast.id, series.account_id).catch((err) => {
      console.error(`[run-now] background execution failed for child ${childBroadcast.id}:`, err);
    });

    return NextResponse.json({ success: true, broadcastId: childBroadcast.id });
  } catch (err: any) {
    console.error('Error in run-now endpoint:', err);
    return NextResponse.json({ error: 'Failed to process run-now request' }, { status: 500 });
  }
}
