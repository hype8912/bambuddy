# Storage Locations (#1004)

Structured storage locations let you manage physical shelves, drawers, and dryboxes as a catalog instead of free-text only.

## Architecture

- **`locations` table** — catalog of named storage spots (`name` + case-insensitive `name_key`).
- **`spool.location_id`** — source of truth for structured assignment.
- **`spool.storage_location`** — denormalized display string and Spoolman wire format; always derived on write via `location_service.resolve_spool_location_fields()`.
- **Frontend** — spool form sends only `location_id`; backend fills `storage_location`.

## Location vs Storage Location vs AMS Location

| UI label | Meaning |
|----------|---------|
| **Location** (inventory table column) | AMS slot or printer assignment (e.g. `H2D-1 B4`) |
| **Storage Location** | Physical shelf/drawer where the spool lives when not in AMS |
| **Locations page** | Catalog of named storage spots with spool counts |

## Managing locations

1. Open **Inventory → Locations**
2. Click **Add Location** and enter a name (e.g. `Regal Etage 2`)
3. Optionally set a **Capacity** (0 = unlimited)
4. Assign spools via the spool edit form **Storage Location** dropdown
5. Click a location row to filter inventory by that shelf

## Spoolman mode

Bambuddy keeps a local location catalog. When Spoolman integration is enabled:

- Assigning a location writes the location **name** to Spoolman's `location` field
- Listing locations syncs distinct names from Spoolman into the catalog
- Renaming a location bulk-renames spools in Spoolman via `PATCH /location/{old}`

## Capacity

A location can have a capacity: the number of spools it holds, such as a bin for 4 spools. Set it with **Add Location** or **Edit** in **Inventory → Locations**. A full location refuses another spool.

- **0 means unlimited**, which is the default. Any whole number from 0 to 100,000 is accepted; anything else is refused with a 422.
- Only **active** spools count. An archived spool frees its slot.
- A spool takes a new slot only when it will be active, in that location, and wasn't already an active spool there. Editing a spool in place, archiving it, moving it out, clearing its location, and moving an archived spool are never refused.
- Lowering a limit below the number of spools in the location is refused (409 `capacity_below_occupancy`). Raising it, or setting 0, is always allowed.

### What blocks and what warns

| Action | Into a full location |
|--------|----------------------|
| Add a spool, bulk add, move or edit a spool's location | Blocked (409 `location_full`) |
| Bulk edit | Blocked as a whole; nothing is changed |
| Restore one archived spool | Blocked |
| Bulk restore | Allowed, with a warning (`capacity_warnings`) |
| CSV import | Allowed, with a warning in the preview and after the import |
| Backup restore | Never checked |

A location that holds more spools than its capacity (after a bulk restore or CSV import) stays usable: you can edit its spools, but not add more until it is back under the limit. It shows "exceeds capacity", and the location filter shows `used/capacity` with a warning mark.

The error response has `detail.code`, `message`, `location_id`, `location_name`, `capacity`, `occupied`, `incoming` and `free`. The UI uses these to say whether the location is full or has only some room left.

### Spoolman mode

Counts come from Spoolman: active spools are matched to a location by name. If Spoolman can't be reached, anything that needs a count for a **limited** location fails with 503, so a limit is never skipped silently. Unlimited locations keep working.

### Known limits

- The AMS sync assigns spools to slots, not to storage locations, so it does not check capacity.
- The check and the write are not one atomic step: two requests adding to the last free slot at the same moment can both succeed.
- The GitHub backup does not include locations, so capacity isn't in it. The full backup ZIP does, and restoring an older backup gives each location a capacity of 0.

## Upgrade migration

Existing free-text `storage_location` values are automatically imported into the location catalog and linked on upgrade (case-insensitive dedup via `name_key`).

## Testing before release

1. `./test_frontend.sh` — i18n parity, lint, Vitest
2. `./test_backend.sh` — Ruff, pytest (includes `test_locations_api.py`, `test_location_service.py`, `test_location_capacity_api.py`)
3. Manual: assign a spool to a location → open **Locations** → spool count updates without reload
4. Companion PR in [bambuddy-wiki](https://github.com/maziggy/bambuddy-wiki) (user-facing guide)
