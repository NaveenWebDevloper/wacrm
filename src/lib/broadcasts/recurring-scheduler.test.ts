import { describe, it, expect } from 'vitest';
import {
  mapScheduleToCron,
  calculateNextRunAt,
  validateCronExpression,
  validateRepeatConfig,
} from './recurring-scheduler';

describe('recurring-scheduler', () => {
  describe('mapScheduleToCron', () => {
    it('maps daily schedule correctly', () => {
      const cron = mapScheduleToCron({
        repeatType: 'daily',
        repeatTime: '09:30',
      });
      expect(cron).toBe('30 9 * * *');
    });

    it('maps weekly schedule correctly', () => {
      const cron = mapScheduleToCron({
        repeatType: 'weekly',
        repeatTime: '18:00',
        dayOfWeek: 1, // Monday
      });
      expect(cron).toBe('0 18 * * 1');
    });

    it('maps monthly schedule correctly', () => {
      const cron = mapScheduleToCron({
        repeatType: 'monthly',
        repeatTime: '00:05',
        dayOfMonth: 15,
      });
      expect(cron).toBe('5 0 15 * *');
    });

    it('uses custom cron directly', () => {
      const cron = mapScheduleToCron({
        repeatType: 'cron',
        cronExpression: '*/5 * * * *',
      });
      expect(cron).toBe('*/5 * * * *');
    });
  });

  describe('calculateNextRunAt', () => {
    it('calculates daily next run correctly', () => {
      const fromDate = new Date('2026-06-30T08:00:00Z');
      const nextRun = calculateNextRunAt({
        repeatType: 'daily',
        repeatTime: '09:00',
        timezone: 'UTC',
        fromDate,
      });
      expect(nextRun.toISOString()).toBe('2026-06-30T09:00:00.000Z');
    });

    it('calculates daily next run for next day if time has passed', () => {
      const fromDate = new Date('2026-06-30T10:00:00Z');
      const nextRun = calculateNextRunAt({
        repeatType: 'daily',
        repeatTime: '09:00',
        timezone: 'UTC',
        fromDate,
      });
      expect(nextRun.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    });

    it('handles different timezones correctly', () => {
      // 2026-06-30 08:00:00 UTC is 2026-06-30 04:00:00 EDT (America/New_York)
      const fromDate = new Date('2026-06-30T08:00:00Z');
      const nextRun = calculateNextRunAt({
        repeatType: 'daily',
        repeatTime: '09:00', // 9:00 AM EDT, which is 13:00 UTC
        timezone: 'America/New_York',
        fromDate,
      });
      expect(nextRun.toISOString()).toBe('2026-06-30T13:00:00.000Z');
    });
  });

  describe('validateCronExpression', () => {
    it('returns true for valid expressions', () => {
      expect(validateCronExpression('0 9 * * *')).toBe(true);
      expect(validateCronExpression('*/15 * * * *')).toBe(true);
    });

    it('returns false for invalid expressions', () => {
      expect(validateCronExpression('invalid cron')).toBe(false);
      expect(validateCronExpression('60 9 * * *')).toBe(false);
    });
  });
});
