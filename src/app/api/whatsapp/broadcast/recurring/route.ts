import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { calculateNextRunAt, validateRepeatConfig } from '@/lib/broadcasts/recurring-scheduler';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

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

    const body = await request.json();
    const {
      name,
      template_name,
      template_language,
      template_variables,
      audience_filter,
      repeat_type,
      repeat_time,
      day_of_week,
      day_of_month,
      cron_expression,
      timezone,
      end_condition,
      end_date,
      max_executions,
    } = body;

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 });
    }

    if (!template_name) {
      return NextResponse.json({ error: 'Template name is required' }, { status: 400 });
    }

    const validation = validateRepeatConfig({
      repeatType: repeat_type,
      repeatTime: repeat_time,
      dayOfWeek: day_of_week,
      dayOfMonth: day_of_month,
      cronExpression: cron_expression,
    });

    if (!validation.valid) {
      return NextResponse.json({ error: validation.error || 'Invalid repeat config' }, { status: 400 });
    }

    let nextRunAt: string | null = null;
    try {
      const nextRunDate = calculateNextRunAt({
        repeatType: repeat_type,
        repeatTime: repeat_time,
        dayOfWeek: day_of_week,
        dayOfMonth: day_of_month,
        cronExpression: cron_expression,
        timezone: timezone || 'UTC',
        fromDate: new Date(),
      });
      nextRunAt = nextRunDate.toISOString();
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to calculate next run date: ${err.message}` }, { status: 400 });
    }

    if (end_condition === 'date' && end_date) {
      if (new Date(end_date) <= new Date()) {
        return NextResponse.json({ error: 'End date must be in the future' }, { status: 400 });
      }
      if (nextRunAt && new Date(nextRunAt) >= new Date(end_date)) {
        return NextResponse.json({ error: 'First scheduled run occurs after the end date' }, { status: 400 });
      }
    }

    const admin = supabaseAdmin();
    const { data: series, error: insError } = await admin
      .from('broadcast_series')
      .insert({
        account_id: accountId,
        user_id: user.id,
        name: name.trim(),
        template_name,
        template_language: template_language || 'en_US',
        template_variables,
        audience_filter,
        repeat_type,
        repeat_time,
        day_of_week,
        day_of_month,
        cron_expression,
        timezone: timezone || 'UTC',
        status: 'active',
        next_run_at: nextRunAt,
        max_executions: end_condition === 'executions' ? max_executions : null,
        end_date: end_condition === 'date' ? end_date : null,
      })
      .select('id')
      .single();

    if (insError || !series) {
      return NextResponse.json({ error: `Failed to create campaign series: ${insError?.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true, seriesId: series.id });
  } catch (err: any) {
    console.error('Error in recurring broadcast creation POST:', err);
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
