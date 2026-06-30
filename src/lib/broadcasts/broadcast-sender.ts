import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { Contact } from '@/types';

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;
const INSERT_BATCH_SIZE = 200;

async function upsertCsvContacts(
  supabase: any,
  csvRows: { phone: string; name?: string }[],
  accountId: string,
  userId?: string
): Promise<Contact[]> {
  if (csvRows.length === 0) return [];

  const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    if (row.phone) uniqueByPhone.set(row.phone, row);
  }
  const phones = [...uniqueByPhone.keys()];

  const { data: existing, error: lookupErr } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .in('phone', phones);

  if (lookupErr) {
    throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
  }

  const byPhone = new Map<string, Contact>();
  for (const c of (existing ?? []) as Contact[]) {
    if (c.phone) byPhone.set(c.phone, c);
  }

  const missing = phones
    .filter((p) => !byPhone.has(p))
    .map((phone) => ({
      user_id: userId || null,
      account_id: accountId,
      phone,
      name: uniqueByPhone.get(phone)?.name ?? null,
    }));

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: insertErr } = await supabase
      .from('contacts')
      .insert(chunk)
      .select();

    if (insertErr) {
      throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
    }
    for (const c of (inserted ?? []) as Contact[]) {
      if (c.phone) byPhone.set(c.phone, c);
    }
  }

  return phones
    .map((p) => byPhone.get(p))
    .filter((c): c is Contact => Boolean(c));
}

export async function resolveAudience(
  supabase: any,
  audience: any,
  accountId: string,
  userId?: string
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (audience.type === 'all') {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    contacts = data ?? [];
  } else if (
    audience.type === 'tags' &&
    audience.tagIds &&
    audience.tagIds.length > 0
  ) {
    const { data: contactTags, error: tagError } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.tagIds);

    if (tagError)
      throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

    if (contactTags && contactTags.length > 0) {
      const uniqueContactIds = [
        ...new Set(contactTags.map((ct: any) => ct.contact_id)),
      ];
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .in('id', uniqueContactIds)
        .eq('account_id', accountId);
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    }
  } else if (audience.type === 'custom_field' && audience.customField) {
    contacts = await resolveCustomFieldAudience(supabase, audience.customField, accountId);
  } else if (audience.type === 'csv' && audience.csvContacts) {
    contacts = await upsertCsvContacts(supabase, audience.csvContacts, accountId, userId);
  }

  // Apply exclude tags (works across all contact-derived audience types).
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const { data: excludeRows } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.excludeTagIds);
    const excludedIds = new Set((excludeRows ?? []).map((r: any) => r.contact_id));
    contacts = contacts.filter((c) => !excludedIds.has(c.id));
  }

  return contacts;
}

async function resolveCustomFieldAudience(
  supabase: any,
  filter: any,
  accountId: string
): Promise<Contact[]> {
  const { fieldId, operator, value } = filter;

  let query = supabase
    .from('contact_custom_values')
    .select('contact_id')
    .eq('custom_field_id', fieldId);

  if (operator === 'is') query = query.eq('value', value);
  else if (operator === 'is_not') query = query.neq('value', value);
  else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

  const { data: matches, error: matchErr } = await query;
  if (matchErr)
    throw new Error(`Custom-field filter failed: ${matchErr.message}`);

  const contactIds = [...new Set((matches ?? []).map((m: any) => m.contact_id))];
  if (contactIds.length === 0) return [];

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .in('id', contactIds)
    .eq('account_id', accountId);
  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
  return data ?? [];
}

type CustomValueIndex = Map<string, Map<string, string>>;

async function fetchCustomValueIndex(
  supabase: any,
  contactIds: string[]
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function resolveVariables(
  variables: Record<string, any>,
  contact: Contact,
  customValues?: Map<string, string>
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    return customValues?.get(v.value) ?? '';
  });
}

async function sendTemplateMessageWithRetry(params: any, maxRetries = 3): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await sendTemplateMessage(params);
    } catch (err: any) {
      attempt++;
      const errMsg = err?.message || '';
      
      const isTransient = 
        errMsg.includes('rate limit') || 
        errMsg.includes('80007') || 
        errMsg.includes('request failed') || 
        errMsg.includes('timeout') ||
        errMsg.includes('500') ||
        errMsg.includes('503');
        
      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }
      
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function executeBroadcast(broadcastId: string, accountId: string): Promise<void> {
  console.log(`[Sender] Started executeBroadcast for run ID: ${broadcastId}, account ID: ${accountId}`);
  const supabase = supabaseAdmin();
  const startedAt = new Date().toISOString();
  
  let logId: string | null = null;
  let totalRecipients = 0;
  
  try {
    const { data: broadcast, error: bcError } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('id', broadcastId)
      .single();
      
    if (bcError || !broadcast) {
      throw new Error(`Failed to load broadcast: ${bcError?.message || 'not found'}`);
    }
    
    console.log(`[Sender] Spawning execution log for parent series: ${broadcast.parent_series_id || 'None'}`);
    const { data: logRow, error: logError } = await supabase
      .from('broadcast_execution_logs')
      .insert({
        account_id: accountId,
        series_id: broadcast.parent_series_id || null,
        broadcast_id: broadcastId,
        status: 'running',
        started_at: startedAt,
      })
      .select()
      .single();
      
    if (logError || !logRow) {
      throw new Error(`Failed to create execution log: ${logError?.message}`);
    }
    logId = logRow.id;
    console.log(`[Sender] Created execution log ID: ${logId}`);
    
    const { count } = await supabase
      .from('broadcast_recipients')
      .select('*', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId);
      
    let recipientsList: any[] = [];
    
    if (count === 0) {
      console.log(`[Sender] Resolving contacts list for audience filter type: ${broadcast.audience_filter?.type || 'all'}...`);
      const contacts = await resolveAudience(supabase, broadcast.audience_filter, accountId, broadcast.user_id);
      console.log(`[Sender] Audience resolved. Found ${contacts.length} contacts.`);
      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }
      
      console.log(`[Sender] Updating total_recipients count to ${contacts.length} in broadcasts table...`);
      await supabase
        .from('broadcasts')
        .update({ total_recipients: contacts.length })
        .eq('id', broadcastId);
        
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcastId,
        contact_id: contact.id,
        status: 'pending',
      }));
      
      console.log(`[Sender] Creating ${recipientRows.length} recipient rows in pending state...`);
      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: insErr } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (insErr) {
          throw new Error(`Failed to insert recipients: ${insErr.message}`);
        }
      }
      console.log('[Sender] Recipient pending rows created successfully');
    } else {
      console.log(`[Sender] Found ${count} pre-existing recipient rows. Safe retry resume path.`);
    }
    
    const { data: recs, error: recsErr } = await supabase
      .from('broadcast_recipients')
      .select('*, contact:contacts(*)')
      .eq('broadcast_id', broadcastId);
      
    if (recsErr || !recs) {
      throw new Error(`Failed to load recipients: ${recsErr?.message}`);
    }
    recipientsList = recs;
    totalRecipients = recipientsList.length;
    
    const contactIds = recipientsList
      .map((r) => r.contact?.id)
      .filter((id): id is string => Boolean(id));
    const customValueIndex = await fetchCustomValueIndex(supabase, contactIds);
    
    console.log('[Sender] Loading WhatsApp credential config and approved templates from DB...');
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();
      
    if (configError || !config) {
      throw new Error('WhatsApp not configured for this account.');
    }
    const accessToken = decrypt(config.access_token);
    
    const { data: rawTemplateRow } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', broadcast.template_name)
      .eq('language', broadcast.template_language || 'en_US')
      .maybeSingle();
      
    let sentCount = 0;
    let failedCount = 0;
    
    console.log(`[Sender] Starting Meta API dispatch loop over ${recipientsList.length} recipients...`);
    for (let i = 0; i < recipientsList.length; i += SEND_BATCH_SIZE) {
      const batch = recipientsList.slice(i, i + SEND_BATCH_SIZE);
      
      const pendingBatch = batch.filter(r => r.status === 'pending');
      if (pendingBatch.length === 0) {
        for (const r of batch) {
          if (r.status === 'failed') failedCount++;
          else sentCount++;
        }
        continue;
      }
      
      for (const recipient of pendingBatch) {
        const phone = recipient.contact?.phone;
        if (!phone) {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'No phone number on contact' })
            .eq('id', recipient.id);
          continue;
        }
        
        const sanitized = sanitizePhoneForMeta(phone);
        if (!isValidE164(sanitized)) {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'Invalid phone number format' })
            .eq('id', recipient.id);
          continue;
        }
        
        const params = resolveVariables(
          broadcast.template_variables || {},
          recipient.contact,
          customValueIndex.get(recipient.contact.id)
        );
        
        const variants = phoneVariants(sanitized);
        let sentMessageId: string | null = null;
        let lastError: string | null = null;
        
        console.log(`[Sender] Calling Meta API sendTemplateMessage for phone variant: ${variants[0]}`);
        for (const variant of variants) {
          try {
            const result = await sendTemplateMessageWithRetry({
              phoneNumberId: config.phone_number_id,
              accessToken,
              to: variant,
              templateName: broadcast.template_name,
              language: broadcast.template_language || 'en_US',
              template: rawTemplateRow ?? undefined,
              params,
            });
            sentMessageId = result.messageId;
            lastError = null;
            break;
          } catch (error: any) {
            lastError = error?.message || 'Unknown Meta API error';
            if (!lastError || !isRecipientNotAllowedError(lastError)) {
              break;
            }
          }
        }

        if (sentMessageId) {
          console.log(`[Sender] Meta call success, message ID UUID: ${sentMessageId}`);
          sentCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              whatsapp_message_id: sentMessageId,
              error_message: null
            })
            .eq('id', recipient.id);
        } else {
          console.warn(`[Sender] Meta call failed. Error: ${lastError}`);
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: lastError || 'Failed to send'
            })
            .eq('id', recipient.id);
        }
      }
      
      if (i + SEND_BATCH_SIZE < recipientsList.length) {
        await new Promise((resolve) => setTimeout(resolve, SEND_BATCH_DELAY_MS));
      }
    }
    
    console.log('[Sender] Meta send loop complete');
    const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
    console.log(`[Sender] Updating child run status to: ${finalStatus} in database...`);
    await supabase
      .from('broadcasts')
      .update({ status: finalStatus })
      .eq('id', broadcastId);
      
    if (logId) {
      console.log(`[Sender] Updating execution log state to: ${finalStatus === 'failed' ? 'failed' : 'success'}`);
      await supabase
        .from('broadcast_execution_logs')
        .update({
          status: finalStatus === 'failed' ? 'failed' : 'success',
          finished_at: new Date().toISOString(),
          recipient_count: totalRecipients,
          sent_count: sentCount,
          failed_count: failedCount,
          duration_ms: Date.now() - new Date(startedAt).getTime(),
        })
        .eq('id', logId);
    }
    console.log('[Sender] Finished executeBroadcast successfully');
    
  } catch (err: any) {
    console.error(`[Sender] executeBroadcast encountered error:`, err.message);
    
    await supabase
      .from('broadcasts')
      .update({ status: 'failed' })
      .eq('id', broadcastId);
      
    if (logId) {
      await supabase
        .from('broadcast_execution_logs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: err?.message || 'Unknown execution error',
          recipient_count: totalRecipients,
          duration_ms: Date.now() - new Date(startedAt).getTime(),
        })
        .eq('id', logId);
    }
  }
}
