/**
 * Bulk edit: the storage-location picker shows free slots and disables
 * locations that can't take the selected spools. Spools already in a
 * location keep their slot, so they don't count against it.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { render } from '../utils';
import { BulkEditSpoolsModal } from '../../components/BulkEditSpoolsModal';

// Echo the params so the option labels are readable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'inventory.locationFreeSlots' ? `${params?.name} (${params?.free} free of ${params?.capacity})` : key,
  }),
}));

const locations = [
  { id: 1, name: 'Roomy', capacity: 10, spool_count: 2 }, // 8 free
  { id: 2, name: 'Tight', capacity: 4, spool_count: 3 }, // 1 free
  { id: 3, name: 'Full', capacity: 2, spool_count: 2 }, // 0 free
  { id: 4, name: 'Unlimited', capacity: 0, spool_count: 40 },
];

const baseProps = {
  isOpen: true,
  selectedCount: 3,
  isPending: false,
  availableLocations: locations,
  availableMaterials: [],
  availableSubtypes: [],
  availableBrands: [],
  availableCategories: [],
  availableMaterialNumbers: [],
  availableSlicerFilaments: [],
  availableSlicerFilamentNames: [],
  onClose: vi.fn(),
  onApply: vi.fn(),
};

function openLocationList() {
  const row = screen.getByText('inventory.storageLocation').closest('div.flex')!;
  fireEvent.click(within(row as HTMLElement).getByRole('checkbox'));
  fireEvent.focus(within(row as HTMLElement).getByRole('textbox'));
}

const optionButton = (label: RegExp) => screen.getByRole('button', { name: label }) as HTMLButtonElement;

describe('BulkEditSpoolsModal location capacity', () => {
  it('shows free slots and disables locations too small for the selection', () => {
    render(<BulkEditSpoolsModal {...baseProps} selectedActiveCount={3} selectedActiveByLocation={{}} />);
    openLocationList();

    expect(optionButton(/Roomy \(8 free of 10\)/).disabled).toBe(false);
    expect(optionButton(/Tight \(1 free of 4\)/).disabled).toBe(true);
    expect(optionButton(/Full \(0 free of 2\)/).disabled).toBe(true);
    // Unlimited locations show no count and are never blocked.
    expect(optionButton(/^Unlimited$/).disabled).toBe(false);
  });

  it("doesn't count selected spools that are already in the location", () => {
    // 3 selected; 2 of them already sit in "Tight", so only 1 needs a slot.
    render(<BulkEditSpoolsModal {...baseProps} selectedActiveCount={3} selectedActiveByLocation={{ 2: 2 }} />);
    openLocationList();

    expect(optionButton(/Tight/).disabled).toBe(false);
    // Spools elsewhere still need a slot in "Full".
    expect(optionButton(/Full/).disabled).toBe(true);
  });

  it("doesn't count archived spools (they take no slot)", () => {
    // 5 selected but only 1 is active.
    render(
      <BulkEditSpoolsModal {...baseProps} selectedCount={5} selectedActiveCount={1} selectedActiveByLocation={{}} />,
    );
    openLocationList();

    expect(optionButton(/Tight/).disabled).toBe(false);
    expect(optionButton(/Full/).disabled).toBe(true);
  });
});
