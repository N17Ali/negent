import { describe, it, expect, vi, afterEach } from 'vitest';
import { isWithinDeliveryHours } from './time';

// Tehran is UTC+3:30. The delivery window is 09:00–21:00 Tehran time.
// DELIVERY_START_HOUR=9 (inclusive), DELIVERY_END_HOUR=21 (exclusive).

describe('isWithinDeliveryHours', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true at 12:00 Tehran (08:30 UTC)', () => {
    // 2026-07-10T08:30:00Z = 12:00 Tehran
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T08:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });

  it('returns true at exactly 09:00 Tehran (05:30 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T05:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });

  it('returns false at exactly 21:00 Tehran (17:30 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T17:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(false);
  });

  it('returns false at 22:00 Tehran (18:30 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T18:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(false);
  });

  it('returns false at 08:00 Tehran (04:30 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T04:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(false);
  });

  it('returns false at midnight Tehran (20:30 UTC previous day)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T20:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(false);
  });

  it('returns true at 20:59 Tehran (17:29 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T17:29:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });

  it('returns true at 09:30 Tehran (06:00 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T06:00:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });

  it('returns true at 15:00 Tehran (11:30 UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T11:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });

  it('handles the half-hour timezone offset correctly (Tehran :30)', () => {
    // Tehran is UTC+3:30 — verify the :30 offset is respected by checking
    // a boundary that only works if the offset is +3:30, not +3:00 or +4:00.
    // 05:00 UTC = 08:30 Tehran (before window), 05:30 UTC = 09:00 Tehran (in window)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T05:00:00Z'));
    expect(isWithinDeliveryHours()).toBe(false);
    vi.setSystemTime(new Date('2026-07-10T05:30:00Z'));
    expect(isWithinDeliveryHours()).toBe(true);
  });
});
