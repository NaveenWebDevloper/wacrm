import { NextResponse } from 'next/server'
import { RecurringBroadcastScheduler } from '@/lib/broadcasts/recurring-broadcast-scheduler'

/**
 * Drain due `automation_pending_executions` rows, due one-off scheduled
 * broadcasts, and recurring broadcast series.
 * Meant to be hit on a schedule (Vercel Cron / external pinger) —
 * requires a shared secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  const vercelCronSecret = process.env.CRON_SECRET

  if (!expected && !vercelCronSecret) {
    console.error('[Cron Endpoint] Verification failed: Neither AUTOMATION_CRON_SECRET nor CRON_SECRET is configured.');
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const suppliedXHeader = request.headers.get('x-cron-secret')
  const authHeader = request.headers.get('Authorization')
  const suppliedBearerToken = authHeader?.startsWith('Bearer ') 
    ? authHeader.substring(7) 
    : null

  let authorized = false
  let triggerSource = 'unknown'

  if (expected && suppliedXHeader === expected) {
    authorized = true
    triggerSource = 'custom-external-pinger'
  } else if (vercelCronSecret && suppliedBearerToken === vercelCronSecret) {
    authorized = true
    triggerSource = 'vercel-cron'
  }

  if (!authorized) {
    console.warn(`[Cron Endpoint] Unauthorized access attempt. Supplied x-cron-secret: "${suppliedXHeader}", Authorization header present: ${!!authHeader}`);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log(`[Cron Endpoint] [DIAGNOSTIC] Cron triggered successfully. Source: ${triggerSource}. User-Agent: "${request.headers.get('user-agent')}"`);

  try {
    const results = await RecurringBroadcastScheduler.run()
    console.log('[Cron Endpoint] [DIAGNOSTIC] Cron processing complete. Results:', results);
    return NextResponse.json(results)
  } catch (err: any) {
    console.error('[Cron Endpoint] [DIAGNOSTIC] Cron processing encountered error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

