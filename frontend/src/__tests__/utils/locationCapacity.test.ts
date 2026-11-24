import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';
import {
  capacityErrorMessage,
  capacityWarningsSummary,
  formatOccupancy,
  freeSlots,
  isLocationFull,
  isOverCapacity,
} from '../../utils/locationCapacity';

// Echo the key and params so the tests see which message was picked.
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${JSON.stringify(params)}` : key) as unknown as TFunction;

const loc = (capacity: number, spool_count: number) => ({ capacity, spool_count });

describe('isLocationFull / isOverCapacity', () => {
  it('treats capacity 0 as unlimited', () => {
    expect(isLocationFull(loc(0, 99))).toBe(false);
    expect(isOverCapacity(loc(0, 99))).toBe(false);
  });

  it('is full at exactly capacity but not over it', () => {
    expect(isLocationFull(loc(4, 4))).toBe(true);
    expect(isOverCapacity(loc(4, 4))).toBe(false);
  });

  it('is full and over capacity above it', () => {
    expect(isLocationFull(loc(4, 6))).toBe(true);
    expect(isOverCapacity(loc(4, 6))).toBe(true);
  });

  it('has room below capacity', () => {
    expect(isLocationFull(loc(4, 3))).toBe(false);
  });
});

describe('freeSlots / formatOccupancy', () => {
  it('returns null free slots when unlimited', () => {
    expect(freeSlots(loc(0, 5))).toBeNull();
  });

  it('never returns negative free slots', () => {
    expect(freeSlots(loc(4, 6))).toBe(0);
    expect(freeSlots(loc(4, 1))).toBe(3);
  });

  it('formats used/capacity, or just the count when unlimited', () => {
    expect(formatOccupancy(loc(4, 3))).toBe('3/4');
    expect(formatOccupancy(loc(0, 3))).toBe('3');
  });
});

function conflict(code: string, detail: Record<string, unknown>) {
  return new ApiError('english fallback', 409, code, detail);
}

describe('capacityErrorMessage', () => {
  it('uses the "full" message when no slot is free', () => {
    const msg = capacityErrorMessage(
      t,
      conflict('location_full', { location_name: 'Bin', capacity: 4, occupied: 4, free: 0, incoming: 1 }),
    );
    expect(msg).toContain('inventory.locationFull|');
    expect(msg).toContain('"name":"Bin"');
  });

  it('uses the partial-room message when some slots are free', () => {
    const msg = capacityErrorMessage(
      t,
      conflict('location_full', { location_name: 'Bin', capacity: 4, occupied: 2, free: 2, incoming: 3 }),
    );
    expect(msg).toContain('inventory.locationFullPartial|');
    expect(msg).toContain('"free":2');
  });

  it('translates capacity_below_occupancy', () => {
    const msg = capacityErrorMessage(
      t,
      conflict('capacity_below_occupancy', { location_name: 'Bin', capacity: 1, occupied: 3 }),
    );
    expect(msg).toContain('locations.capacityBelowOccupancy|');
  });

  it('returns null for other errors', () => {
    expect(capacityErrorMessage(t, new Error('boom'))).toBeNull();
    expect(capacityErrorMessage(t, new ApiError('nope', 500))).toBeNull();
    expect(capacityErrorMessage(t, conflict('something_else', { a: 1 }))).toBeNull();
    // A 409 without structured detail can't be translated.
    expect(capacityErrorMessage(t, new ApiError('plain 409', 409))).toBeNull();
  });
});

describe('capacityWarningsSummary', () => {
  it('joins one entry per location', () => {
    const tt = vi.fn((key: string, p?: Record<string, unknown>) => `${p?.name}:${p?.occupied}/${p?.capacity}`);
    const out = capacityWarningsSummary(tt as unknown as TFunction, [
      { location_id: 1, location_name: 'A', capacity: 2, occupied: 3, over_by: 1, incoming: 0 },
      { location_id: 2, location_name: 'B', capacity: 4, occupied: 6, over_by: 2, incoming: 0 },
    ]);
    expect(out).toBe('A:3/2; B:6/4');
  });
});
