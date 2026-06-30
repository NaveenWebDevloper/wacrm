'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { 
  Broadcast, 
  BroadcastRecipient, 
  RecipientStatus, 
  BroadcastSeries, 
  BroadcastExecutionLog 
} from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  Pause,
  Play,
  XCircle,
  Copy,
  Clock,
  History
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
  getRecurringStatus,
} from '@/lib/broadcast-status';

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [parentSeries, setParentSeries] = useState<BroadcastSeries | null>(null);
  const [isSeries, setIsSeries] = useState(false);
  const [series, setSeries] = useState<BroadcastSeries | null>(null);
  const [childRuns, setChildRuns] = useState<Broadcast[]>([]);
  const [executionLogs, setExecutionLogs] = useState<BroadcastExecutionLog[]>([]);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const supabase = createClient();

        // 1. Try to fetch from broadcasts table first
        const { data: bc } = await supabase
          .from('broadcasts')
          .select('*')
          .eq('id', broadcastId)
          .maybeSingle();

        if (bc) {
          setBroadcast(bc);
          setIsSeries(false);

          if (bc.parent_series_id) {
            const { data: ps } = await supabase
              .from('broadcast_series')
              .select('*')
              .eq('id', bc.parent_series_id)
              .maybeSingle();
            setParentSeries(ps);
          }

          const { data: recs, error: recsError } = await supabase
            .from('broadcast_recipients')
            .select('*, contact:contacts(*)')
            .eq('broadcast_id', broadcastId)
            .order('created_at', { ascending: false });

          if (recsError) throw recsError;
          setRecipients(recs ?? []);
        } else {
          // 2. Try to fetch from broadcast_series table
          const { data: bs } = await supabase
            .from('broadcast_series')
            .select('*')
            .eq('id', broadcastId)
            .maybeSingle();

          if (bs) {
            setSeries(bs);
            setIsSeries(true);

            const { data: runs, error: runsError } = await supabase
              .from('broadcasts')
              .select('*')
              .eq('parent_series_id', broadcastId)
              .order('created_at', { ascending: false });

            if (runsError) throw runsError;
            setChildRuns(runs ?? []);

            const { data: logs } = await supabase
              .from('broadcast_execution_logs')
              .select('*')
              .eq('series_id', broadcastId)
              .order('created_at', { ascending: false });

            setExecutionLogs(logs ?? []);
          } else {
            throw new Error('Broadcast not found');
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load broadcast');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [broadcastId]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter]
  );

  // Roll up stats for Series
  const rolledUpStats = useMemo(() => {
    return childRuns.reduce(
      (acc, r) => {
        acc.total_recipients += r.total_recipients;
        acc.sent_count += r.sent_count;
        acc.delivered_count += r.delivered_count;
        acc.read_count += r.read_count;
        acc.replied_count += r.replied_count;
        acc.failed_count += r.failed_count;
        return acc;
      },
      {
        total_recipients: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      }
    );
  }, [childRuns]);

  async function handleAction(action: 'pause' | 'resume' | 'cancel' | 'run-now' | 'duplicate') {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/${action}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${action}`);
      }
      toast.success(`Action '${action}' completed successfully`);
      if (action === 'duplicate' && data.newSeriesId) {
        router.push(`/broadcasts/${data.newSeriesId}`);
      } else if (action === 'run-now' && data.broadcastId) {
        router.push(`/broadcasts/${data.broadcastId}`);
      } else {
        window.location.reload();
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  function handleExport() {
    if (!broadcast) return;
    const header = [
      'Contact',
      'Phone',
      'Status',
      'Sent At',
      'Delivered At',
      'Read At',
      'Replied At',
      'Error',
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from(isSeries ? 'broadcast_series' : 'broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(`Failed to delete: ${delErr.message}`);
      return;
    }
    toast.success(isSeries ? 'Recurring campaign deleted' : 'Broadcast deleted');
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || (!broadcast && !series)) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? 'Broadcast not found'}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          Back to Broadcasts
        </Button>
      </div>
    );
  }

  // ── RENDER SCENARIO 1: RECURRING CAMPAIGN SERIES DETAIL ─────────────
  if (isSeries && series) {
    const statusConfig = getRecurringStatus(series.status);
    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              onClick={() => router.push('/broadcasts')}
              className="border-border"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-foreground">{series.name}</h1>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusConfig.classes}`}
                >
                  {statusConfig.label}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
                <span>Template: {series.template_name}</span>
                <span>-</span>
                <span>Created {new Date(series.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {series.status === 'active' && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionLoading}
                onClick={() => handleAction('pause')}
                className="border-border text-muted-foreground"
              >
                <Pause className="mr-1.5 h-3.5 w-3.5" />
                Pause
              </Button>
            )}

            {series.status === 'paused' && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionLoading}
                onClick={() => handleAction('resume')}
                className="border-border text-muted-foreground"
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Resume
              </Button>
            )}

            {(series.status === 'active' || series.status === 'paused') && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => handleAction('run-now')}
                  className="border-border text-muted-foreground"
                >
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  Run Now
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => handleAction('cancel')}
                  className="border-border text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />
                  Cancel
                </Button>
              </>
            )}

            <Button
              variant="outline"
              size="sm"
              disabled={actionLoading}
              onClick={() => handleAction('duplicate')}
              className="border-border text-muted-foreground"
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Duplicate
            </Button>

            {confirmDelete ? (
              <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
                <span className="text-red-300">Delete recurring series?</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Confirm'}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
        </div>

        {/* Recurrence config panel */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Repeat schedule</p>
              <p className="text-sm font-semibold capitalize text-foreground">
                {series.repeat_type} {series.repeat_time ? `at ${series.repeat_time.substring(0, 5)}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Next scheduled execution</p>
              <p className="text-sm font-semibold text-foreground">
                {series.status === 'active' && series.next_run_at 
                  ? new Date(series.next_run_at).toLocaleString() 
                  : 'None'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Runs count / limits</p>
              <p className="text-sm font-semibold text-foreground">
                {series.execution_count} runs 
                {series.max_executions ? ` (Limit: ${series.max_executions})` : ''}
              </p>
            </div>
          </div>
        </div>

        {/* Stats card rollup */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Total Message Dispatches"
            value={rolledUpStats.total_recipients}
            total={rolledUpStats.total_recipients}
            icon={<Users className="h-4 w-4" />}
            color="bg-muted text-muted-foreground"
          />
          <StatCard
            label="Sent"
            value={rolledUpStats.sent_count}
            total={rolledUpStats.total_recipients}
            icon={<Send className="h-4 w-4" />}
            color="bg-primary/10 text-primary"
          />
          <StatCard
            label="Delivered"
            value={rolledUpStats.delivered_count}
            total={rolledUpStats.total_recipients}
            icon={<CheckCheck className="h-4 w-4" />}
            color="bg-teal-500/10 text-teal-400"
          />
          <StatCard
            label="Read"
            value={rolledUpStats.read_count}
            total={rolledUpStats.total_recipients}
            icon={<Eye className="h-4 w-4" />}
            color="bg-blue-500/10 text-blue-400"
          />
          <StatCard
            label="Replied"
            value={rolledUpStats.replied_count}
            total={rolledUpStats.total_recipients}
            icon={<MessageCircle className="h-4 w-4" />}
            color="bg-indigo-500/10 text-indigo-400"
          />
          <StatCard
            label="Failed"
            value={rolledUpStats.failed_count}
            total={rolledUpStats.total_recipients}
            icon={<AlertCircle className="h-4 w-4" />}
            color="bg-red-500/10 text-red-400"
          />
        </div>

        {/* History of child runs */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-medium text-foreground">Execution History</h2>
          </div>
          {childRuns.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-sm text-muted-foreground">No execution runs logged yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Run Name</TableHead>
                    <TableHead className="text-right text-muted-foreground">Recipients</TableHead>
                    <TableHead className="text-muted-foreground">Delivery</TableHead>
                    <TableHead className="text-muted-foreground">Read</TableHead>
                    <TableHead className="text-muted-foreground">Status</TableHead>
                    <TableHead className="text-muted-foreground">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {childRuns.map((run) => {
                    const rStatus = getBroadcastStatus(run.status);
                    return (
                      <TableRow 
                        key={run.id} 
                        className="cursor-pointer border-border hover:bg-muted/50"
                        onClick={() => router.push(`/broadcasts/${run.id}`)}
                      >
                        <TableCell className="font-medium text-foreground">{run.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{run.total_recipients}</TableCell>
                        <TableCell>
                          <RateCell value={run.delivered_count} total={run.total_recipients} color="bg-primary" />
                        </TableCell>
                        <TableCell>
                          <RateCell value={run.read_count} total={run.total_recipients} color="bg-blue-500" />
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}>
                            {rStatus.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(run.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Detailed execution logs */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-medium text-foreground">System Execution Logs (Claims & Runs)</h2>
          </div>
          {executionLogs.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-sm text-muted-foreground">No system logs available.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Run ID</TableHead>
                    <TableHead className="text-muted-foreground">Status</TableHead>
                    <TableHead className="text-muted-foreground">Duration</TableHead>
                    <TableHead className="text-right text-muted-foreground">Recipients</TableHead>
                    <TableHead className="text-right text-muted-foreground">Sent</TableHead>
                    <TableHead className="text-right text-muted-foreground">Failed</TableHead>
                    <TableHead className="text-muted-foreground">Started At</TableHead>
                    <TableHead className="text-muted-foreground">System Errors</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {executionLogs.map((log) => (
                    <TableRow key={log.id} className="border-border">
                      <TableCell className="font-mono text-xs text-muted-foreground">{log.id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          log.status === 'success' 
                            ? 'bg-green-500/10 text-green-400 border-green-500/20' 
                            : log.status === 'running' 
                              ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                              : 'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                          {log.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {log.finished_at && log.duration_ms 
                          ? `${(log.duration_ms / 1000).toFixed(1)}s` 
                          : '-'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{log.recipient_count}</TableCell>
                      <TableCell className="text-right tabular-nums text-green-400">{log.sent_count}</TableCell>
                      <TableCell className="text-right tabular-nums text-red-400">{log.failed_count}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(log.started_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400 font-mono">
                        {log.error_message || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── RENDER SCENARIO 2: INDIVIDUAL RUN DETAIL VIEW ──────────────────
  if (broadcast) {
    const status = getBroadcastStatus(broadcast.status);
    const funnelSteps: FunnelStep[] = [
      { label: 'Sent', value: broadcast.sent_count, color: 'bg-primary' },
      { label: 'Delivered', value: broadcast.delivered_count, color: 'bg-teal-500' },
      { label: 'Read', value: broadcast.read_count, color: 'bg-blue-500' },
      { label: 'Replied', value: broadcast.replied_count, color: 'bg-indigo-500' },
    ];

    return (
      <div className="space-y-6">
        {/* Parent Link if part of a recurring series */}
        {parentSeries && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-2 text-sm text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            <span>
              This is execution run #{broadcast.name.match(/Run #(\d+)/)?.[1] || ''} of recurring campaign:{' '}
              <Link href={`/broadcasts/${parentSeries.id}`} className="font-semibold text-primary underline hover:text-primary/80">
                {parentSeries.name}
              </Link>
            </span>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              onClick={() => router.push('/broadcasts')}
              className="border-border"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                >
                  {status.pulse && (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                    </span>
                  )}
                  {status.label}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
                <span>Template: {broadcast.template_name}</span>
                <span>-</span>
                <span>Created {new Date(broadcast.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
              <span className="text-red-300">Delete this broadcast?</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Confirm'}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={broadcast.status === 'sending'}
              onClick={() => setConfirmDelete(true)}
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Total Recipients"
            value={broadcast.total_recipients}
            total={broadcast.total_recipients}
            icon={<Users className="h-4 w-4" />}
            color="bg-muted text-muted-foreground"
          />
          <StatCard
            label="Sent"
            value={broadcast.sent_count}
            total={broadcast.total_recipients}
            icon={<Send className="h-4 w-4" />}
            color="bg-primary/10 text-primary"
          />
          <StatCard
            label="Delivered"
            value={broadcast.delivered_count}
            total={broadcast.total_recipients}
            icon={<CheckCheck className="h-4 w-4" />}
            color="bg-teal-500/10 text-teal-400"
          />
          <StatCard
            label="Read"
            value={broadcast.read_count}
            total={broadcast.total_recipients}
            icon={<Eye className="h-4 w-4" />}
            color="bg-blue-500/10 text-blue-400"
          />
          <StatCard
            label="Replied"
            value={broadcast.replied_count}
            total={broadcast.total_recipients}
            icon={<MessageCircle className="h-4 w-4" />}
            color="bg-indigo-500/10 text-indigo-400"
          />
          <StatCard
            label="Failed"
            value={broadcast.failed_count}
            total={broadcast.total_recipients}
            icon={<AlertCircle className="h-4 w-4" />}
            color="bg-red-500/10 text-red-400"
          />
        </div>

        <FunnelChart steps={funnelSteps} />

        {/* Recipients Table */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-foreground">
              Recipients ({filteredRecipients.length}
              {statusFilter !== 'all' ? ` of ${recipients.length}` : ''})
            </h2>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-border text-muted-foreground hover:bg-muted"
                    />
                  }
                >
                  <Filter className="h-3.5 w-3.5" />
                  {statusFilter === 'all'
                    ? 'All statuses'
                    : getRecipientStatus(statusFilter).label}
                  <ChevronDown className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="border-border bg-popover">
                  <DropdownMenuItem
                    onClick={() => setStatusFilter('all')}
                    className={statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'}
                  >
                    All statuses
                  </DropdownMenuItem>
                  {RECIPIENT_STATUSES.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={statusFilter === s ? 'text-primary' : 'text-popover-foreground'}
                    >
                      {getRecipientStatus(s).label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={recipients.length === 0}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5" />
                Export CSV
              </Button>
            </div>
          </div>

          {filteredRecipients.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-sm text-muted-foreground">
                {recipients.length === 0 ? 'No recipients found.' : 'No recipients match this filter.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Contact</TableHead>
                    <TableHead className="text-muted-foreground">Phone</TableHead>
                    <TableHead className="text-muted-foreground">Status</TableHead>
                    <TableHead className="text-muted-foreground">Sent</TableHead>
                    <TableHead className="text-muted-foreground">Delivered</TableHead>
                    <TableHead className="text-muted-foreground">Read</TableHead>
                    <TableHead className="text-muted-foreground">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRecipients.map((recipient) => {
                    const rStatus = getRecipientStatus(recipient.status);
                    return (
                      <TableRow key={recipient.id} className="border-border">
                        <TableCell className="font-medium text-foreground">
                          {recipient.contact?.name ?? 'Unknown'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{recipient.contact?.phone ?? '-'}</TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}>
                            {rStatus.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.sent_at ? new Date(recipient.sent_at).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.delivered_at ? new Date(recipient.delivered_at).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.read_at ? new Date(recipient.read_at).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-red-400">
                          {recipient.error_message ?? '-'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
