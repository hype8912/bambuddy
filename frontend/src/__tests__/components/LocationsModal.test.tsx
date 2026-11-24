import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocationsModal } from '../../components/LocationsModal';
import { api, ApiError } from '../../api/client';

const mockShowToast = vi.fn();
const mockOnClose = vi.fn();
const mockOnPickLocation = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getLocations: vi.fn(),
    createLocation: vi.fn(),
    updateLocation: vi.fn(),
    deleteLocation: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const locations = [
  { id: 1, name: 'Shelf A', identifier: null, spool_count: 2, capacity: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 2, name: 'Drawer 1', identifier: null, spool_count: 0, capacity: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
];

function renderModal(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LocationsModal open={open} onClose={mockOnClose} onPickLocation={mockOnPickLocation} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LocationsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getLocations).mockResolvedValue(locations);
  });

  it('renders nothing when open=false', () => {
    const { container } = renderModal(false);
    expect(container.firstChild).toBeNull();
    expect(api.getLocations).not.toHaveBeenCalled();
  });

  it('renders locations from API when open', async () => {
    renderModal();
    expect(await screen.findByText('Shelf A')).toBeInTheDocument();
    expect(screen.getByText('Drawer 1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders empty state when API returns no locations', async () => {
    vi.mocked(api.getLocations).mockResolvedValue([]);
    renderModal();
    expect(await screen.findByText(/locations\.empty|no storage locations/i)).toBeInTheDocument();
  });

  it('opens create editor and calls createLocation on submit', async () => {
    vi.mocked(api.createLocation).mockResolvedValue({
      id: 3,
      name: 'Garage',
      identifier: null,
      spool_count: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    await user.click(screen.getByRole('button', { name: /add location|locations\.add/i }));
    const input = screen.getByLabelText(/name|locations\.name/i);
    await user.type(input, 'Garage');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));
    await waitFor(() => {
      expect(api.createLocation).toHaveBeenCalledWith({ name: 'Garage', capacity: 0 });
    });
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/created|locations\.created/i), 'success');
  });

  it('submits create form on Enter key', async () => {
    vi.mocked(api.createLocation).mockResolvedValue({
      id: 3,
      name: 'Garage',
      identifier: null,
      spool_count: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    await user.click(screen.getByRole('button', { name: /add location|locations\.add/i }));
    const input = screen.getByLabelText(/name|locations\.name/i);
    await user.type(input, 'Garage{Enter}');
    await waitFor(() => {
      expect(api.createLocation).toHaveBeenCalledWith({ name: 'Garage', capacity: 0 });
    });
  });

  it('Escape closes the inner editor first, then the outer modal', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    // Open the inner editor; both dialogs are now in the DOM.
    await user.click(screen.getByRole('button', { name: /add location|locations\.add/i }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    // First Escape closes the editor only.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });
    expect(mockOnClose).not.toHaveBeenCalled();
    // Second Escape closes the outer modal.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  it('edits a location and calls updateLocation', async () => {
    vi.mocked(api.updateLocation).mockResolvedValue({
      id: 2,
      name: 'Drawer 2',
      identifier: null,
      spool_count: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Drawer 1');
    const editButtons = screen.getAllByTitle(/edit|common\.edit/i);
    await user.click(editButtons[1]);
    const input = screen.getByLabelText(/name|locations\.name/i);
    await user.clear(input);
    await user.type(input, 'Drawer 2');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));
    await waitFor(() => {
      expect(api.updateLocation).toHaveBeenCalledWith(2, { name: 'Drawer 2', capacity: 0 });
    });
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/updated|locations\.updated/i), 'success');
  });

  it('shows occupancy with Full and Exceeds-capacity badges', async () => {
    vi.mocked(api.getLocations).mockResolvedValue([
      { ...locations[0], id: 10, name: 'Bin Full', spool_count: 4, capacity: 4 },
      { ...locations[0], id: 11, name: 'Bin Over', spool_count: 6, capacity: 4 },
      { ...locations[0], id: 12, name: 'Bin Roomy', spool_count: 1, capacity: 4 },
    ]);
    renderModal();
    await screen.findByText('Bin Full');
    expect(screen.getByText('4/4')).toBeInTheDocument();
    expect(screen.getByText('6/4')).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
    expect(screen.getAllByText(/locations\.full|^full$/i)).toHaveLength(1);
    expect(screen.getAllByText(/locations\.exceedsCapacity|exceeds capacity/i)).toHaveLength(1);
  });

  it('sends the capacity entered in the editor', async () => {
    vi.mocked(api.createLocation).mockResolvedValue({
      id: 3,
      name: 'Bin',
      identifier: null,
      spool_count: 0,
      capacity: 4,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    await user.click(screen.getByRole('button', { name: /add location|locations\.add/i }));
    await user.type(screen.getByLabelText(/^name$|locations\.name/i), 'Bin');
    const cap = screen.getByLabelText(/capacity/i);
    await user.clear(cap);
    await user.type(cap, '4');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));
    await waitFor(() => {
      expect(api.createLocation).toHaveBeenCalledWith({ name: 'Bin', capacity: 4 });
    });
  });

  it('shows a capacity_below_occupancy 409 as a translated error', async () => {
    const err = new ApiError('raw english', 409);
    (err as unknown as { code: string }).code = 'capacity_below_occupancy';
    (err as unknown as { detail: Record<string, unknown> }).detail = {
      location_name: 'Shelf A',
      occupied: 2,
      capacity: 1,
    };
    vi.mocked(api.updateLocation).mockRejectedValue(err);
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    await user.click(screen.getAllByTitle(/edit|common\.edit/i)[0]);
    const cap = screen.getByLabelText(/capacity/i);
    await user.clear(cap);
    await user.type(cap, '1');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringMatching(/holds 2 spools|capacityBelowOccupancy/),
        'error',
      );
    });
  });

  it('deletes an empty location after confirmation', async () => {
    vi.mocked(api.deleteLocation).mockResolvedValue({ status: 'deleted' });
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Drawer 1');
    const row = screen.getByText('Drawer 1').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row!).getByTitle(/^Delete$/i));
    await user.click(screen.getAllByRole('button', { name: /^Delete$/i }).pop()!);
    await waitFor(() => {
      expect(api.deleteLocation).toHaveBeenCalledWith(2);
    });
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/deleted|locations\.deleted/i), 'success');
  });

  it('blocks delete when spool_count > 0', async () => {
    renderModal();
    await screen.findByText('Shelf A');
    const blockedDelete = screen.getByTitle(/Remove all spools from this location before deleting/i);
    expect(blockedDelete).toBeDisabled();
  });

  it('shows error toast when create returns 409 duplicate name', async () => {
    vi.mocked(api.createLocation).mockRejectedValue(
      new ApiError('A location with this name already exists', 409),
    );
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    await user.click(screen.getByRole('button', { name: /add location|locations\.add/i }));
    await user.type(screen.getByLabelText(/name|locations\.name/i), 'Shelf A');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('A location with this name already exists', 'error');
    });
  });

  it('shows error toast when delete fails', async () => {
    vi.mocked(api.deleteLocation).mockRejectedValue(new Error('Delete failed'));
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Drawer 1');
    const row = screen.getByText('Drawer 1').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row!).getByTitle(/^Delete$/i));
    await user.click(screen.getAllByRole('button', { name: /^Delete$/i }).pop()!);
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('Delete failed', 'error');
    });
  });

  it('row click calls onPickLocation and onClose', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Shelf A');
    const row = screen.getByText('Shelf A').closest('tr')!;
    await user.click(row);
    expect(mockOnPickLocation).toHaveBeenCalledWith(1);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('shows error toast when rename returns 409 collision', async () => {
    vi.mocked(api.updateLocation).mockRejectedValue(
      new ApiError('A location with this name already exists', 409),
    );
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Drawer 1');

    const editButtons = screen.getAllByTitle(/edit|common\.edit/i);
    await user.click(editButtons[1]);
    const input = screen.getByLabelText(/name|locations\.name/i);
    await user.clear(input);
    await user.type(input, 'Shelf A');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        'A location with this name already exists',
        'error',
      );
    });
  });
});

describe('LocationsModal — startCreating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getLocations).mockResolvedValue(locations);
    vi.mocked(api.createLocation).mockResolvedValue({
      id: 3,
      name: 'Garage',
      identifier: null,
      spool_count: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
  });

  function renderCreatingModal(withPickLocation: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LocationsModal
            open
            onClose={mockOnClose}
            onPickLocation={withPickLocation ? mockOnPickLocation : undefined}
            startCreating
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('calls onPickLocation and onClose on a successful create', async () => {
    const user = userEvent.setup();
    renderCreatingModal(true);

    const input = await screen.findByLabelText(/name|locations\.name/i);
    await user.type(input, 'Garage');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));

    await waitFor(() => expect(mockOnPickLocation).toHaveBeenCalledWith(3));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('still closes on a successful create when onPickLocation is not provided', async () => {
    // Regression: gating the close on onPickLocation being set left editorOpen
    // false with open still true — nothing left to render (startCreating has
    // no location-list view to fall back to), but the caller never told to
    // close, so the modal effectively vanished stuck "open".
    const user = userEvent.setup();
    renderCreatingModal(false);

    const input = await screen.findByLabelText(/name|locations\.name/i);
    await user.type(input, 'Garage');
    await user.click(screen.getByRole('button', { name: /save|common\.save/i }));

    await waitFor(() => expect(api.createLocation).toHaveBeenCalledWith({ name: 'Garage', capacity: 0 }));
    await waitFor(() => expect(mockOnClose).toHaveBeenCalledTimes(1));
    expect(mockOnPickLocation).not.toHaveBeenCalled();
  });
});
