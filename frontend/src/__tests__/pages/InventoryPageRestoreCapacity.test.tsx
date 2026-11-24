/**
 * Restoring an archived spool into a full storage location: the single restore
 * shows the translated 409, and a bulk restore (which never blocks) warns about
 * the locations it leaves over capacity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import InventoryPageRouter from '../../pages/InventoryPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseSettings = {
  auto_archive: true,
  save_thumbnails: true,
  capture_finish_photo: true,
  default_filament_cost: 25.0,
  currency: 'USD',
  energy_cost_per_kwh: 0.15,
  energy_tracking_mode: 'total',
  spoolman_enabled: false,
  spoolman_url: '',
  spoolman_sync_mode: 'auto',
  spoolman_disable_weight_sync: false,
  spoolman_report_partial_usage: true,
  check_updates: true,
  check_printer_firmware: true,
  include_beta_updates: false,
  language: 'en',
  notification_language: 'en',
  bed_cooled_threshold: 35,
  ams_humidity_good: 40,
  ams_humidity_fair: 60,
  ams_temp_good: 28,
  ams_temp_fair: 35,
  ams_history_retention_days: 30,
  per_printer_mapping_expanded: false,
  date_format: 'system',
  time_format: 'system',
  default_printer_id: null,
  dark_style: 'classic',
  dark_background: 'neutral',
  dark_accent: 'green',
  light_style: 'classic',
  light_background: 'neutral',
  light_accent: 'green',
  ftp_retry_enabled: true,
  ftp_retry_count: 3,
  ftp_retry_delay: 2,
  ftp_timeout: 30,
  mqtt_enabled: false,
  mqtt_broker: '',
  mqtt_port: 1883,
  mqtt_username: '',
  mqtt_password: '',
  mqtt_topic_prefix: 'bambuddy',
  mqtt_use_tls: false,
  external_url: '',
  ha_enabled: false,
  ha_url: '',
  ha_token: '',
  ha_url_from_env: false,
  ha_token_from_env: false,
  ha_env_managed: false,
  library_disk_warning_gb: 5.0,
  camera_view_mode: 'window',
  preferred_slicer: 'bambu_studio',
  prometheus_enabled: false,
  prometheus_token: '',
  low_stock_threshold: 20.0,
};

const archivedSpool = {
    // Archived spool: 500 g consumed. Pre-fix this consumption disappeared
    // from "Total Consumed" the moment the spool was archived (#1390 fb).
    id: 2,
    material: 'PETG',
    subtype: null,
    brand: 'eSun',
    color_name: 'Blue',
    rgba: '0000FFFF',
    label_weight: 1000,
    core_weight: 250,
    weight_used: 500,
    weight_used_baseline: 0,
    slicer_filament: null,
    slicer_filament_name: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    note: null,
    added_full: null,
    last_used: null,
    encode_time: null,
    tag_uid: null,
    tray_uuid: null,
    data_origin: null,
    tag_type: null,
    archived_at: '2026-04-01T00:00:00Z',
    created_at: '2025-01-02T00:00:00Z',
    updated_at: '2025-01-02T00:00:00Z',
    k_profiles: [],
    cost_per_kg: null,
    last_scale_weight: null,
    last_weighed_at: null,
  };


describe('InventoryPage — restore into a full location', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/settings/', () => HttpResponse.json(baseSettings)),
      http.get('/api/v1/inventory/spools', () =>
        HttpResponse.json([{ ...archivedSpool, id: 5, location_id: 9, storage_location: 'Bin' }]),
      ),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({ spoolman_enabled: 'false' })),
    );
  });

  afterEach(() => {
    localStorage.removeItem('bambuddy-inventory-group');
  });

  it('shows the translated message when a single restore is refused', async () => {
    server.use(
      http.post('/api/v1/inventory/spools/:id/restore', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'location_full',
              message: 'english fallback',
              location_id: 9,
              location_name: 'Bin',
              capacity: 1,
              occupied: 1,
              incoming: 1,
              free: 0,
            },
          },
          { status: 409 },
        ),
      ),
    );
    render(<InventoryPageRouter />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    fireEvent.click(await screen.findByTitle('Restore'));

    expect(await screen.findByText('"Bin" is full (1/1).')).toBeInTheDocument();
  });

  it('warns after a bulk restore that leaves a location over capacity', async () => {
    server.use(
      http.post('/api/v1/inventory/spools/bulk-restore', () =>
        HttpResponse.json({
          restored: 1,
          already_active: [],
          not_found: [],
          capacity_warnings: [
            { location_id: 9, location_name: 'Bin', capacity: 1, occupied: 2, over_by: 1, incoming: 0 },
          ],
        }),
      ),
    );
    render(<InventoryPageRouter />);

    fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
    fireEvent.click(await screen.findByLabelText('Select row'));
    // Buttons that show the word "Restore" (the per-row one is icon-only).
    const withText = async () =>
      (await screen.findAllByRole('button', { name: /^Restore$/ })).filter((b) => b.textContent?.trim() === 'Restore');
    fireEvent.click((await withText())[0]);
    // The confirm dialog adds a second one; its confirm button comes last.
    await waitFor(async () => expect((await withText()).length).toBeGreaterThan(1));
    const confirms = await withText();
    fireEvent.click(confirms[confirms.length - 1]);

    expect(await screen.findByText('Locations over capacity: Bin (2/1 spools)')).toBeInTheDocument();
  });
});
