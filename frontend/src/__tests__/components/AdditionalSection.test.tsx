import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { AdditionalSection } from '../../components/spool-form/AdditionalSection';
import { defaultFormData } from '../../components/spool-form/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseProps = {
  formData: defaultFormData,
  updateField: vi.fn(),
  spoolCatalog: [],
  currencySymbol: '$',
  availableCategories: [],
  availableMaterialNumbers: [],
  globalLowStockThreshold: 20,
};

describe('AdditionalSection', () => {
  it('renders SpoolWeightPicker', () => {
    render(<AdditionalSection {...baseProps} />);
    // SpoolWeightPicker renders the 'inventory.coreWeight' label
    expect(screen.getByText('inventory.coreWeight')).toBeTruthy();
  });

  it('renders the material number field in internal mode (#2870)', () => {
    render(<AdditionalSection {...baseProps} spoolmanMode={false} />);
    expect(screen.getByText('inventory.materialNumber')).toBeTruthy();
  });

  it('hides the material number field in Spoolman mode (#2870)', () => {
    // In Spoolman mode the number is the filament-level article_number,
    // maintained in Spoolman itself — the form must not offer an input
    // whose value would be silently dropped.
    render(<AdditionalSection {...baseProps} spoolmanMode={true} />);
    expect(screen.queryByText('inventory.materialNumber')).toBeNull();
  });

  describe('storage location capacity', () => {
    const locations = [
      { id: 1, name: 'Roomy', capacity: 4, spool_count: 1 },
      { id: 2, name: 'Full Bin', capacity: 4, spool_count: 4 },
      { id: 3, name: 'Over Bin', capacity: 4, spool_count: 6 },
      { id: 4, name: 'Unlimited', capacity: 0, spool_count: 50 },
    ];

    it('disables full locations and suffixes them, but not roomy or unlimited ones', () => {
      render(<AdditionalSection {...baseProps} availableLocations={locations} />);
      const opts = screen.getAllByRole('option') as HTMLOptionElement[];
      const byValue = (v: number) => opts.find((o) => o.value === String(v))!;
      expect(byValue(1).disabled).toBe(false);
      expect(byValue(1).textContent).toBe('Roomy');
      expect(byValue(2).disabled).toBe(true);
      expect(byValue(2).textContent).toBe('inventory.locationFullOption');
      expect(byValue(3).disabled).toBe(true);
      expect(byValue(4).disabled).toBe(false);
    });

    it('keeps the spool\'s own full location selectable after picking another', () => {
      // The spool sits in "Full Bin" (2) but the form now points at "Roomy" (1):
      // moving back must stay possible, since the spool still holds that slot.
      render(
        <AdditionalSection
          {...baseProps}
          formData={{ ...defaultFormData, location_id: 1 }}
          availableLocations={locations}
          currentLocationId={2}
        />,
      );
      const opts = screen.getAllByRole('option') as HTMLOptionElement[];
      expect(opts.find((o) => o.value === '2')!.disabled).toBe(false);
      // Other full locations stay blocked.
      expect(opts.find((o) => o.value === '3')!.disabled).toBe(true);
    });

    it('warns when the selected location is over capacity', () => {
      render(
        <AdditionalSection
          {...baseProps}
          formData={{ ...defaultFormData, location_id: 3 }}
          availableLocations={locations}
          currentLocationId={3}
        />,
      );
      expect(screen.getByText('inventory.locationOverCapacityWarning')).toBeTruthy();
    });

    it('says a preselected full location (not the spool\'s own) is full', () => {
      render(
        <AdditionalSection
          {...baseProps}
          formData={{ ...defaultFormData, location_id: 2 }}
          availableLocations={locations}
          currentLocationId={null}
        />,
      );
      expect(screen.getByText('inventory.locationFull')).toBeTruthy();
    });

    it('shows no warning for a location with room', () => {
      render(
        <AdditionalSection {...baseProps} formData={{ ...defaultFormData, location_id: 1 }} availableLocations={locations} />,
      );
      expect(screen.queryByText('inventory.locationOverCapacityWarning')).toBeNull();
      expect(screen.queryByText('inventory.locationFull')).toBeNull();
    });

    it('ignores capacity for an archived spool', () => {
      render(
        <AdditionalSection
          {...baseProps}
          formData={{ ...defaultFormData, location_id: 3 }}
          availableLocations={locations}
          currentLocationId={3}
          ignoreLocationCapacity
        />,
      );
      const opts = screen.getAllByRole('option') as HTMLOptionElement[];
      expect(opts.find((o) => o.value === '2')!.disabled).toBe(false);
      expect(screen.queryByText('inventory.locationOverCapacityWarning')).toBeNull();
    });
  });
});
