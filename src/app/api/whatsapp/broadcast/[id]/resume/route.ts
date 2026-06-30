import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { calculateNextRunAt } from '@/lib/broadcasts/recurring-scheduler';

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

    if (series.status !== 'paused') {
      return NextResponse.json({ error: `Cannot resume series in ${series.status} status` }, { status: 400 });
    }

    // Recalculate next run from current time to avoid missed backlogs
    let nextRunAt: string | null = null;
    try {
      const nextRunDate = calculateNextRunAt({
        repeatType: series.repeat_type,
        repeatTime: series.repeat_time || undefined,
        dayOfWeek: series.day_of_week !== null ? series.day_of_week : undefined,
        dayOfMonth: series.day_of_month !== null ? series.day_of_month : undefined,
        cronExpression: series.cron_expression || undefined,
        timezone: series.timezone,
        fromDate: new Date(),
      });
      nextRunAt = nextRunDate.toISOString();
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to calculate next run date: ${err.message}` }, { status: 400 });
    }

    // Check if end_date was already passed
    if (series.end_date && new Date() >= new Date(series.end_date)) {
      return NextResponse.json({ error: 'Cannot resume because end date has passed' }, { status: 400 });
    }

    const { error: updError } = await admin
      .from('broadcast_series')
      .update({
        status: 'active',
        next_run_at: nextRunAt,
      })
      .eq('id', id);

    if (updError) {
      return NextResponse.json({ error: `Failed to resume series: ${updError.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, next_run_at: nextRunAt });
  } catch (err: any) {
    console.error('Error in resume endpoint:', err);
    return NextResponse.json({ error: 'Failed to process resume request' }, { status: 500 });
  }
}
