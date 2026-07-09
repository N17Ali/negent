import { DELIVERY_START_HOUR, DELIVERY_END_HOUR, TIMEZONE } from './constants';

/**
 * True when the current wall-clock hour in TIMEZONE (Asia/Tehran) is inside the
 * DELIVERY_START_HOUR–DELIVERY_END_HOUR window. Shared by the select cron (only select
 * during hours we'd deliver) and the deliver cron (never message subscribers at night).
 */
export function isWithinDeliveryHours(): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const hour = parseInt(hourStr, 10);
  return hour >= DELIVERY_START_HOUR && hour < DELIVERY_END_HOUR;
}
