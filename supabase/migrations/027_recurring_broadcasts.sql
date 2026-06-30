-- Recurring Campaign Configuration
CREATE TABLE IF NOT EXISTS broadcast_series (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  template_variables JSONB,
  audience_filter JSONB,
  
  -- Structured scheduling columns
  repeat_type TEXT NOT NULL CHECK (repeat_type IN ('daily', 'weekly', 'monthly', 'cron')),
  repeat_time TIME,             -- e.g. '09:00:00', NULL if custom cron
  day_of_week INTEGER,           -- 0-6 (Sunday-Saturday), for weekly
  day_of_month INTEGER,          -- 1-31, for monthly
  cron_expression TEXT,          -- for custom cron
  timezone TEXT NOT NULL DEFAULT 'UTC',
  
  -- Execution state
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  execution_count INTEGER NOT NULL DEFAULT 0,
  max_executions INTEGER,        -- NULL if unlimited
  end_date TIMESTAMPTZ,          -- NULL if never
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and add policies
ALTER TABLE broadcast_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcast_series_select ON broadcast_series FOR SELECT USING (is_account_member(account_id));
CREATE POLICY broadcast_series_insert ON broadcast_series FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY broadcast_series_update ON broadcast_series FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY broadcast_series_delete ON broadcast_series FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Link existing broadcasts to their series
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS parent_series_id UUID REFERENCES broadcast_series(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_broadcasts_parent_series ON broadcasts(parent_series_id) WHERE parent_series_id IS NOT NULL;

-- Execution logs table
CREATE TABLE IF NOT EXISTS broadcast_execution_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  series_id UUID REFERENCES broadcast_series(id) ON DELETE CASCADE, -- NULL for one-time scheduled runs
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  recipient_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS and add policies
ALTER TABLE broadcast_execution_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY broadcast_execution_logs_select ON broadcast_execution_logs FOR SELECT USING (is_account_member(account_id));

-- Add trigger for updated_at on broadcast_series
DROP TRIGGER IF EXISTS set_updated_at ON broadcast_series;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON broadcast_series FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Atomic claiming function for recurring broadcast series
CREATE OR REPLACE FUNCTION claim_next_broadcast_series(lease_minutes INT DEFAULT 10)
RETURNS SETOF broadcast_series AS $$
DECLARE
  claimed_row broadcast_series;
BEGIN
  -- Find and lock one active series that is due
  SELECT * INTO claimed_row
  FROM broadcast_series
  WHERE status = 'active' 
    AND next_run_at <= NOW()
  ORDER BY next_run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  
  IF claimed_row.id IS NOT NULL THEN
    -- Update next_run_at to lease time so it's locked from other workers
    UPDATE broadcast_series
    SET next_run_at = NOW() + (lease_minutes || ' minutes')::INTERVAL,
        last_run_at = claimed_row.next_run_at,
        execution_count = execution_count + 1,
        updated_at = NOW()
    WHERE id = claimed_row.id;
    
    -- Return the claimed row (with original values before the lease update)
    RETURN NEXT claimed_row;
  END IF;
  
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

