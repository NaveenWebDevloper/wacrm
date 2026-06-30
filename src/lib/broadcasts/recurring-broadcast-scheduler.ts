import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { executeBroadcast } from '@/lib/broadcasts/broadcast-sender'
import { calculateNextRunAt } from '@/lib/broadcasts/recurring-scheduler'

export class RecurringBroadcastScheduler {
  static async run() {
    const admin = supabaseAdmin()
    
    // 1. Process Automations (Existing logic)
    const { data: due, error } = await admin
      .from('automation_pending_executions')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', new Date().toISOString())
      .order('run_at', { ascending: true })
      .limit(50)

    let processedAutomations = 0
    if (!error && due && due.length > 0) {
      for (const row of due) {
        const { data: claim } = await admin
          .from('automation_pending_executions')
          .update({ status: 'running' })
          .eq('id', row.id)
          .eq('status', 'pending')
          .select('id')
          .maybeSingle()
        if (!claim) continue

        await resumePendingExecution({
          id: row.id as string,
          automation_id: row.automation_id as string,
          account_id: row.account_id as string,
          user_id: row.user_id as string,
          contact_id: (row.contact_id as string | null) ?? null,
          log_id: (row.log_id as string | null) ?? null,
          parent_step_id: (row.parent_step_id as string | null) ?? null,
          branch: (row.branch as 'yes' | 'no' | null) ?? null,
          next_step_position: row.next_step_position as number,
          context: (row.context as AutomationContext) ?? {},
        })
        processedAutomations++
      }
    }

    // 2. Process One-time Scheduled Broadcasts
    let processedScheduled = 0
    const { data: dueScheduled, error: schedError } = await admin
      .from('broadcasts')
      .select('id, account_id')
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date().toISOString())
      .limit(10)

    if (!schedError && dueScheduled) {
      for (const row of dueScheduled) {
        const { data: claim } = await admin
          .from('broadcasts')
          .update({ status: 'sending' })
          .eq('id', row.id)
          .eq('status', 'scheduled')
          .select('id')
          .maybeSingle()

        if (!claim) continue

        await executeBroadcast(row.id as string, row.account_id as string)
        processedScheduled++
      }
    }

    // 3. Process Recurring Broadcast Series
    console.log('[Scheduler] Started recurring broadcast check');
    let processedRecurring = 0
    const MAX_RECURRING_PER_TICK = 5

    for (let i = 0; i < MAX_RECURRING_PER_TICK; i++) {
      console.log('[Scheduler] Scanning for due recurring campaign series...');
      const { data: claimedSeries, error: claimError } = await admin
        .rpc('claim_next_broadcast_series', { lease_minutes: 10 })

      if (claimError) {
        console.error('[Scheduler] Error claiming next broadcast series:', claimError.message)
        break
      }

      if (!claimedSeries || claimedSeries.length === 0) {
        console.log('[Scheduler] No due recurring series found');
        break
      }

      const series = claimedSeries[0]
      console.log(`[Scheduler] Claimed series: "${series.name}" (ID: ${series.id})`);

      try {
        const now = new Date()
        const scheduledTime = series.next_run_at ? new Date(series.next_run_at) : now
        let nextRunDate: Date
        try {
          console.log(`[Scheduler] Calculating next scheduled run after ${scheduledTime.toISOString()} in timezone ${series.timezone}...`);
          nextRunDate = calculateNextRunAt({
            repeatType: series.repeat_type,
            repeatTime: series.repeat_time ?? undefined,
            dayOfWeek: series.day_of_week ?? undefined,
            dayOfMonth: series.day_of_month ?? undefined,
            cronExpression: series.cron_expression ?? undefined,
            timezone: series.timezone,
            fromDate: scheduledTime,
          })
          console.log(`[Scheduler] Calculated next schedule: ${nextRunDate.toISOString()}`);
        } catch (calcErr: any) {
          console.error(`[Scheduler] Schedule calculation failed for series ${series.id}, pausing series:`, calcErr.message)
          await admin
            .from('broadcast_series')
            .update({
              status: 'paused',
              next_run_at: null,
            })
            .eq('id', series.id)
          continue;
        }

        const nextRunIso = nextRunDate.toISOString()
        let nextStatus = 'active'
        let finalNextRun: string | null = nextRunIso

        const currentExecCount = series.execution_count + 1
        if (series.max_executions !== null && currentExecCount >= series.max_executions) {
          console.log(`[Scheduler] Max execution count (${series.max_executions}) reached. Completing series.`);
          nextStatus = 'completed'
          finalNextRun = null
        }

        if (series.end_date) {
          const endDate = new Date(series.end_date)
          if (now >= endDate || nextRunDate > endDate) {
            console.log(`[Scheduler] End date (${series.end_date}) reached. Completing series.`);
            nextStatus = 'completed'
            finalNextRun = null
          }
        }

        console.log(`[Scheduler] Updating series schedule next_run_at to ${finalNextRun || 'NULL'} and status to ${nextStatus}...`);
        const { error: updError } = await admin
          .from('broadcast_series')
          .update({
            next_run_at: finalNextRun,
            status: nextStatus,
          })
          .eq('id', series.id)

        if (updError) {
          throw new Error(`Failed to update recurring series schedule: ${updError.message}`)
        }
        console.log('[Scheduler] Series next_run_at updated in DB');

        console.log('[Scheduler] Creating execution run row in broadcasts table...');
        const { data: childBroadcast, error: childError } = await admin
          .from('broadcasts')
          .insert({
            account_id: series.account_id,
            user_id: series.user_id,
            name: `${series.name} (Run #${currentExecCount})`,
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
          .single()

        if (childError || !childBroadcast) {
          throw new Error(`Failed to spawn child execution run: ${childError?.message}`)
        }
        console.log(`[Scheduler] Created child run ID: ${childBroadcast.id}`);

        console.log(`[Scheduler] Calling executeBroadcast for child run ID: ${childBroadcast.id}`);
        await executeBroadcast(childBroadcast.id, series.account_id)
        processedRecurring++
      } catch (err: any) {
        console.error(`[Scheduler] Recurring series execution failed for ID ${series.id}:`, err.message)
      }
    }

    console.log(`[Scheduler] Finished recurring broadcast check. Processed: ${processedRecurring}`);
    return {
      processedAutomations,
      processedScheduled,
      processedRecurring,
    }
  }
}
