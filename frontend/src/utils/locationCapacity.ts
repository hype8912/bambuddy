import type { TFunction } from 'i18next';
import { ApiError, type CapacityWarning } from '../api/client';

interface CapacityFields {
  capacity: number;
  spool_count: number;
}

/** At or above the limit: no more spools fit. Capacity 0 means unlimited. */
export function isLocationFull(loc: CapacityFields): boolean {
  return loc.capacity > 0 && loc.spool_count >= loc.capacity;
}

/** Strictly above the limit (possible after a lenient import or restore). */
export function isOverCapacity(loc: CapacityFields): boolean {
  return loc.capacity > 0 && loc.spool_count > loc.capacity;
}

/** Free slots, or null when the location is unlimited. Never negative. */
export function freeSlots(loc: CapacityFields): number | null {
  if (loc.capacity <= 0) return null;
  return Math.max(0, loc.capacity - loc.spool_count);
}

/** "3/4" for a limited location, just the count when unlimited. */
export function formatOccupancy(loc: CapacityFields): string {
  return loc.capacity > 0 ? `${loc.spool_count}/${loc.capacity}` : String(loc.spool_count);
}

/** Translated text for a `location_full` or `capacity_below_occupancy` ApiError; null for any other error. */
export function capacityErrorMessage(t: TFunction, err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.detail) return null;
  const d = err.detail as Record<string, unknown>;
  const params = {
    name: String(d.location_name ?? ''),
    capacity: Number(d.capacity ?? 0),
    occupied: Number(d.occupied ?? 0),
    free: Number(d.free ?? 0),
    incoming: Number(d.incoming ?? 0),
  };
  if (err.code === 'location_full') {
    return params.free > 0
      ? t('inventory.locationFullPartial', params)
      : t('inventory.locationFull', params);
  }
  if (err.code === 'capacity_below_occupancy') {
    return t('locations.capacityBelowOccupancy', params);
  }
  return null;
}

/** One-line summary of locations left over capacity, for a warning toast. */
export function capacityWarningsSummary(t: TFunction, warnings: CapacityWarning[]): string {
  return warnings
    .map((w) =>
      t('inventory.capacityWarningItem', { name: w.location_name, occupied: w.occupied, capacity: w.capacity }),
    )
    .join('; ');
}
