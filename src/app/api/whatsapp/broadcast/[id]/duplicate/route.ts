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

    // Calculate first next_run_at for the duplicated series
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

    // Insert duplicated series
    const { data: duplicatedSeries, error: insError } = await admin
      .from('broadcast_series')
      .insert({
        account_id: accountId,
        user_id: user.id,
        name: `Copy of ${series.name}`,
        template_name: series.template_name,
        template_language: series.template_language,
        template_variables: series.template_variables,
        audience_filter: series.audience_filter,
        repeat_type: series.repeat_type,
        repeat_time: series.repeat_time,
        day_of_week: series.day_of_week,
        day_of_month: series.day_of_month,
        cron_expression: series.cron_expression,
        timezone: series.timezone,
        status: 'active',
        next_run_at: nextRunAt,
        max_executions: series.max_executions,
        end_date: series.end_date,
      })
      .select('id')
      .single();

    if (insError || !duplicatedSeries) {
      return NextResponse.json({ error: `Failed to duplicate campaign: ${insError?.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, newSeriesId: duplicatedSeries.id });
  } catch (err: any) {
    console.error('Error in duplicate endpoint:', err);
    return NextResponse.json({ error: 'Failed to process duplicate request' }, { status: 500 });
  }
}
