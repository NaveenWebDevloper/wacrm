'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check } from 'lucide-react';

const steps = [
  { label: 'Template', key: 'template' },
  { label: 'Audience', key: 'audience' },
  { label: 'Personalize', key: 'personalize' },
  { label: 'Send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [name, setName] = useState('');

  async function handleSend(schedulePayload?: any) {
    if (!template) return;

    try {
      const supabase = createClient();
      
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error('Not signed in.');
        return;
      }
      if (!accountId) {
        toast.error('Your profile is not linked to an account.');
        return;
      }

      // ── Scenario A: Send Now ───────────────────────────────────────
      if (!schedulePayload || schedulePayload.scheduleType === 'now') {
        const broadcastId = await createAndSendBroadcast({
          name,
          template,
          audience: {
            type: audience.type,
            tagIds: audience.tagIds,
            customField: audience.customField,
            csvContacts: audience.csvContacts,
            excludeTagIds: audience.excludeTagIds,
          },
          variables,
        });
        router.push(`/broadcasts/${broadcastId}`);
        return;
      }

      // ── Scenario B: One-time Scheduled Send ────────────────────────
      if (schedulePayload.repeatType === 'once') {
        const { data, error } = await supabase
          .from('broadcasts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: name.trim(),
            template_name: template.name,
            template_language: template.language ?? 'en_US',
            template_variables: variables,
            audience_filter: {
              type: audience.type,
              tagIds: audience.tagIds,
              customField: audience.customField,
              csvContacts: audience.csvContacts,
              excludeTagIds: audience.excludeTagIds,
            },
            status: 'scheduled',
            scheduled_at: new Date(schedulePayload.oneTimeDate).toISOString(),
            total_recipients: 0,
            sent_count: 0,
            delivered_count: 0,
            read_count: 0,
            replied_count: 0,
            failed_count: 0,
          })
          .select()
          .single();

        if (error || !data) {
          throw new Error(`Failed to schedule broadcast: ${error?.message || 'unknown error'}`);
        }

        toast.success('Broadcast scheduled successfully');
        router.push('/broadcasts');
        return;
      }

      // ── Scenario C: Recurring Broadcast Series ─────────────────────
      const res = await fetch('/api/whatsapp/broadcast/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          template_name: template.name,
          template_language: template.language ?? 'en_US',
          template_variables: variables,
          audience_filter: {
            type: audience.type,
            tagIds: audience.tagIds,
            customField: audience.customField,
            csvContacts: audience.csvContacts,
            excludeTagIds: audience.excludeTagIds,
          },
          repeat_type: schedulePayload.repeatType,
          repeat_time: schedulePayload.repeatTime ? `${schedulePayload.repeatTime}:00` : null,
          day_of_week: schedulePayload.dayOfWeek !== undefined ? schedulePayload.dayOfWeek : null,
          day_of_month: schedulePayload.dayOfMonth !== undefined ? schedulePayload.dayOfMonth : null,
          cron_expression: schedulePayload.cronExpression || null,
          timezone: schedulePayload.timezone,
          end_condition: schedulePayload.endCondition,
          end_date: schedulePayload.endDate ? new Date(schedulePayload.endDate).toISOString() : null,
          max_executions: schedulePayload.maxExecutions || null,
        }),
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || 'Failed to create recurring broadcast series');
      }

      toast.success('Recurring broadcast series created successfully');
      router.push('/broadcasts');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error('Give the broadcast a name before saving a draft.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error('Not signed in.');
      return;
    }
    if (!accountId) {
      toast.error('Your profile is not linked to an account.');
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(`Failed to save draft: ${error.message}`);
      return;
    }
    toast.success('Draft saved');
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">New Broadcast</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create and send a broadcast message to your contacts.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
