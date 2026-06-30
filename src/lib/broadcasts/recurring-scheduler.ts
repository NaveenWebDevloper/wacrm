import { CronExpressionParser } from 'cron-parser';

export function mapScheduleToCron(options: {
  repeatType: 'daily' | 'weekly' | 'monthly' | 'cron';
  repeatTime?: string; // "HH:MM" or "HH:MM:SS"
  dayOfWeek?: number;  // 0-6 (0 = Sunday, 1 = Monday...)
  dayOfMonth?: number; // 1-31
  cronExpression?: string;
}): string {
  if (options.repeatType === 'cron') {
    if (!options.cronExpression) {
      throw new Error('cronExpression is required for cron repeat type');
    }
    return options.cronExpression.trim();
  }

  if (!options.repeatTime) {
    throw new Error('repeatTime is required');
  }

  // Parse time (HH:MM or HH:MM:SS)
  const parts = options.repeatTime.split(':');
  if (parts.length < 2) {
    throw new Error(`Invalid repeatTime format: ${options.repeatTime}`);
  }
  const hour = parseInt(parts[0], 10);
  const minute = parseInt(parts[1], 10);

  if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid repeatTime values: ${options.repeatTime}`);
  }

  switch (options.repeatType) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      if (options.dayOfWeek === undefined || options.dayOfWeek < 0 || options.dayOfWeek > 6) {
        throw new Error('dayOfWeek (0-6) is required for weekly repeat type');
      }
      return `${minute} ${hour} * * ${options.dayOfWeek}`;
    case 'monthly':
      if (options.dayOfMonth === undefined || options.dayOfMonth < 1 || options.dayOfMonth > 31) {
        throw new Error('dayOfMonth (1-31) is required for monthly repeat type');
      }
      return `${minute} ${hour} ${options.dayOfMonth} * *`;
    default:
      throw new Error(`Unknown repeat type: ${options.repeatType}`);
  }
}

export function calculateNextRunAt(options: {
  repeatType: 'daily' | 'weekly' | 'monthly' | 'cron';
  repeatTime?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  cronExpression?: string;
  timezone: string;
  fromDate?: Date;
}): Date {
  const cron = mapScheduleToCron(options);
  const fromDate = options.fromDate || new Date();
  
  const interval = CronExpressionParser.parse(cron, {
    currentDate: fromDate,
    tz: options.timezone || 'UTC'
  });
  
  return interval.next().toDate();
}

export function validateCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch (err) {
    return false;
  }
}

export function validateRepeatConfig(options: {
  repeatType: 'daily' | 'weekly' | 'monthly' | 'cron';
  repeatTime?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  cronExpression?: string;
}): { valid: boolean; error?: string } {
  try {
    mapScheduleToCron(options);
    if (options.repeatType === 'cron' && options.cronExpression) {
      if (!validateCronExpression(options.cronExpression)) {
        return { valid: false, error: 'Invalid cron expression format' };
      }
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Invalid repeat config' };
  }
}

