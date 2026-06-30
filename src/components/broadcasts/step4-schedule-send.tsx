'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, Calendar, Clock } from 'lucide-react';
import { validateCronExpression } from '@/lib/broadcasts/recurring-scheduler';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
  customField?: any;
  excludeTagIds?: string[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: (schedulePayload?: any) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // Scheduling state
  const [scheduleType, setScheduleType] = useState<'now' | 'schedule'>('now');
  const [repeatType, setRepeatType] = useState<'once' | 'daily' | 'weekly' | 'monthly' | 'cron'>('once');
  const [repeatTime, setRepeatTime] = useState<string>('09:00');
  const [dayOfWeek, setDayOfWeek] = useState<number>(1); // Monday
  const [dayOfMonth, setDayOfMonth] = useState<number>(15);
  const [cronExpression, setCronExpression] = useState<string>('0 9 * * *');
  const [timezone, setTimezone] = useState<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });
  const [oneTimeDate, setOneTimeDate] = useState<string>(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 10); // default to 10m in future
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  });

  const [endCondition, setEndCondition] = useState<'never' | 'date' | 'executions'>('never');
  const [endDate, setEndDate] = useState<string>('');
  const [maxExecutions, setMaxExecutions] = useState<number>(10);

  // Validation state
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } catch (err) {
        console.error('Reach calc failed:', err);
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  // Form validation
  useEffect(() => {
    if (scheduleType === 'schedule') {
      if (repeatType === 'once') {
        if (!oneTimeDate) {
          setValidationError('Please select a date and time for execution');
          return;
        }
        if (new Date(oneTimeDate) <= new Date()) {
          setValidationError('Scheduled execution time must be in the future');
          return;
        }
      } else {
        // Recurring validations
        if (!repeatTime && repeatType !== 'cron') {
          setValidationError('Please specify execution time');
          return;
        }
        if (repeatType === 'monthly') {
          if (dayOfMonth < 1 || dayOfMonth > 31) {
            setValidationError('Day of Month must be between 1 and 31');
            return;
          }
        }
        if (repeatType === 'cron') {
          if (!cronExpression) {
            setValidationError('Please enter a cron expression');
            return;
          }
          if (!validateCronExpression(cronExpression)) {
            setValidationError('Invalid cron expression format (must be standard 5-field cron)');
            return;
          }
        }
        if (endCondition === 'date') {
          if (!endDate) {
            setValidationError('Please specify an end date');
            return;
          }
          if (new Date(endDate) <= new Date()) {
            setValidationError('End date must be in the future');
            return;
          }
        }
        if (endCondition === 'executions') {
          if (maxExecutions < 1) {
            setValidationError('Maximum executions must be at least 1');
            return;
          }
        }
      }
    }
    setValidationError(null);
  }, [scheduleType, repeatType, repeatTime, dayOfWeek, dayOfMonth, cronExpression, oneTimeDate, endCondition, endDate, maxExecutions]);

  const handleSendAction = () => {
    if (scheduleType === 'now') {
      onSend();
    } else {
      onSend({
        scheduleType,
        repeatType,
        repeatTime,
        dayOfWeek,
        dayOfMonth,
        cronExpression,
        timezone,
        oneTimeDate,
        endCondition,
        endDate: endCondition === 'date' ? endDate : undefined,
        maxExecutions: endCondition === 'executions' ? maxExecutions : undefined,
      });
    }
  };

  const audienceLabel =
    audience.type === 'all'
      ? 'All Contacts'
      : audience.type === 'tags'
        ? `Tags (${audience.tagIds?.length ?? 0} selected)`
        : audience.type === 'csv'
          ? 'CSV Upload'
          : 'Custom';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Review & Schedule</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure sending schedule, review details, and send.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Broadcast Name</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Summer Sale Announcement"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Delivery Schedule Options */}
      <div className="space-y-4 rounded-xl border border-border bg-card/30 p-4">
        <p className="text-sm font-medium text-foreground">Delivery Schedule</p>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="radio"
              name="scheduleType"
              checked={scheduleType === 'now'}
              onChange={() => setScheduleType('now')}
              className="accent-primary"
            />
            Send Now
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input
              type="radio"
              name="scheduleType"
              checked={scheduleType === 'schedule'}
              onChange={() => setScheduleType('schedule')}
              className="accent-primary"
            />
            Schedule Send
          </label>
        </div>

        {scheduleType === 'schedule' && (
          <div className="mt-4 pt-4 border-t border-border space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Repeat schedule</label>
                <select
                  value={repeatType}
                  onChange={(e) => setRepeatType(e.target.value as any)}
                  className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                >
                  <option value="once">Once</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="cron">Custom Cron</option>
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                >
                  {COMMON_TIMEZONES.includes(timezone) ? null : (
                    <option value={timezone}>{timezone}</option>
                  )}
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Sub-panels based on Repeat Type */}
            {repeatType === 'once' && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Execution Date & Time</label>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <input
                    type="datetime-local"
                    value={oneTimeDate}
                    onChange={(e) => setOneTimeDate(e.target.value)}
                    className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                  />
                </div>
              </div>
            )}

            {repeatType !== 'once' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {repeatType !== 'cron' && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time of Day</label>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <input
                        type="time"
                        value={repeatTime}
                        onChange={(e) => setRepeatTime(e.target.value)}
                        className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                      />
                    </div>
                  </div>
                )}

                {repeatType === 'weekly' && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Day of Week</label>
                    <select
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(parseInt(e.target.value, 10))}
                      className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                    >
                      <option value={1}>Monday</option>
                      <option value={2}>Tuesday</option>
                      <option value={3}>Wednesday</option>
                      <option value={4}>Thursday</option>
                      <option value={5}>Friday</option>
                      <option value={6}>Saturday</option>
                      <option value={0}>Sunday</option>
                    </select>
                  </div>
                )}

                {repeatType === 'monthly' && (
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Day of Month</label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
                      className="border-border bg-muted text-foreground"
                    />
                  </div>
                )}

                {repeatType === 'cron' && (
                  <div className="col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Cron Expression</label>
                    <Input
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                      placeholder="e.g. 0 9 * * *"
                      className="border-border bg-muted text-foreground"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Standard 5-field cron format: minute hour day-of-month month day-of-week
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* End Conditions for Recurring Series */}
            {repeatType !== 'once' && (
              <div className="pt-4 border-t border-border/50 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">End Condition</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="radio"
                      name="endCondition"
                      checked={endCondition === 'never'}
                      onChange={() => setEndCondition('never')}
                      className="accent-primary"
                    />
                    Never End
                  </label>
                  <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="radio"
                      name="endCondition"
                      checked={endCondition === 'date'}
                      onChange={() => setEndCondition('date')}
                      className="accent-primary"
                    />
                    End Date
                  </label>
                  <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <input
                      type="radio"
                      name="endCondition"
                      checked={endCondition === 'executions'}
                      onChange={() => setEndCondition('executions')}
                      className="accent-primary"
                    />
                    Max Executions
                  </label>
                </div>

                {endCondition === 'date' && (
                  <div className="pt-2">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">End Date</label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                    />
                  </div>
                )}

                {endCondition === 'executions' && (
                  <div className="pt-2">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Maximum Runs</label>
                    <Input
                      type="number"
                      min={1}
                      value={maxExecutions}
                      onChange={(e) => setMaxExecutions(parseInt(e.target.value, 10))}
                      className="border-border bg-muted text-foreground w-32"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Validation Error Message */}
      {validationError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
          {validationError}
        </div>
      )}

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">Summary</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Template</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Audience</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Sending broadcast...</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && scheduleType === 'now' && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save as Draft
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing || validationError !== null}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {scheduleType === 'now' ? 'Send Broadcast' : 'Schedule Broadcast'}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  Confirm {scheduleType === 'now' ? 'Broadcast' : 'Scheduled Broadcast'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  You are about to {scheduleType === 'now' ? 'send' : 'schedule'} this broadcast to{' '}
                  <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                  contacts using the{' '}
                  <span className="font-medium text-popover-foreground">{template.name}</span> template.
                  {scheduleType === 'now' && ' This action cannot be undone.'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    handleSendAction();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  Confirm & {scheduleType === 'now' ? 'Send' : 'Schedule'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
