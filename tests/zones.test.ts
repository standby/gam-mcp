import { describe, it, expect } from 'vitest';
import { canonicalTimeZone, offsetMinutes, offsetsDiffer, zoneWarning } from '../src/zones.js';

describe('canonicalTimeZone', () => {
  it('returns the canonical IANA name, or null for a name the runtime does not know', () => {
    expect(canonicalTimeZone('Asia/Seoul')).toBe('Asia/Seoul');
    expect(canonicalTimeZone('asia/seoul')).toBe('Asia/Seoul');
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
  });

  it('fix round 1: refuses a raw UTC offset — Node accepts it as a timeZone, but it is not an IANA name', () => {
    expect(canonicalTimeZone('+08:00')).toBeNull();
    expect(canonicalTimeZone('-0500')).toBeNull();
  });

  it('fix round 1: Etc/GMT offsets stay accepted — spelled with a leading letter, so they are IANA names', () => {
    expect(canonicalTimeZone('Etc/GMT-8')).toBe('Etc/GMT-8');
    expect(canonicalTimeZone('asia/seoul')).toBe('Asia/Seoul');
  });
});

describe('offsetMinutes', () => {
  it('reads whole, half and quarter hour offsets east of UTC', () => {
    const jan = Date.UTC(2026, 0, 15);
    expect(offsetMinutes('Asia/Tokyo', jan)).toBe(540);
    expect(offsetMinutes('America/New_York', jan)).toBe(-300);
    expect(offsetMinutes('UTC', jan)).toBe(0);
    expect(offsetMinutes('Asia/Kolkata', jan)).toBe(330);
    expect(offsetMinutes('Asia/Kathmandu', jan)).toBe(345);
  });

  it('follows daylight saving', () => {
    expect(offsetMinutes('America/New_York', Date.UTC(2026, 6, 1))).toBe(-240);
  });
});

describe('offsetsDiffer', () => {
  it('D4: Asia/Seoul and Asia/Tokyo never differ', () => {
    expect(offsetsDiffer('Asia/Seoul', 'Asia/Tokyo', { start: '2026-01-01', end: '2026-12-31' })).toBe(false);
  });

  it('D4: America/New_York and Asia/Tokyo differ on any day', () => {
    expect(offsetsDiffer('America/New_York', 'Asia/Tokyo', { start: '2026-09-01', end: '2026-09-01' })).toBe(true);
  });

  it('catches a difference that lasts two hours on a transition day', () => {
    // On 2026-03-08 Havana moves to UTC-4 at 05:00Z and New York at 07:00Z.
    expect(offsetsDiffer('America/Havana', 'America/New_York', { start: '2026-03-08', end: '2026-03-08' })).toBe(true);
  });

  it('looks one day beyond each end of the range, and no further', () => {
    expect(offsetsDiffer('America/Havana', 'America/New_York', { start: '2026-03-09', end: '2026-03-09' })).toBe(true);
    expect(offsetsDiffer('America/Havana', 'America/New_York', { start: '2026-03-11', end: '2026-03-13' })).toBe(false);
    expect(offsetsDiffer('America/Havana', 'America/New_York', { start: '2026-03-03', end: '2026-03-06' })).toBe(false);
  });

  it('cannot prove anything about a range it cannot read', () => {
    expect(offsetsDiffer('Asia/Seoul', 'Asia/Tokyo', { start: 'someday', end: '2026-09-01' })).toBe(true);
  });
});

describe('zoneWarning', () => {
  const range = { start: '2026-09-01', end: '2026-09-02' };

  it('is silent for the same zone and for zones that share their offsets', () => {
    expect(zoneWarning('Asia/Tokyo', 'Asia/Tokyo', range)).toBeNull();
    expect(zoneWarning('Asia/Seoul', 'Asia/Tokyo', range)).toBeNull();
  });

  it('names both zones and the range when the offsets differ', () => {
    expect(zoneWarning('America/New_York', 'Asia/Tokyo', range)).toBe(
      "Dates were chosen in America/New_York (GAM_TIMEZONE), but GAM counts each day in the network's time zone, " +
      "Asia/Tokyo, and the two zones' UTC offsets differ on at least one day of 2026-09-01..2026-09-02: " +
      'those days do not cover the same hours as the dates you asked for.',
    );
  });

  it('warns when it cannot tell which days a result covers', () => {
    for (const unknown of [null, { start: '', end: '' }, { start: '2026-09-02', end: '2026-09-01' }]) {
      const w = zoneWarning('Asia/Seoul', 'Asia/Tokyo', unknown);
      expect(w).toContain('Asia/Seoul');
      expect(w).toContain('does not say which days it covers');
    }
  });
});
