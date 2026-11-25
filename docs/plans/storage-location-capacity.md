# Plan: Storage location capacity limits

Status: IN PROGRESS (Phases 1-3 done). Tick the boxes as work lands so a new session can resume. Line numbers are approximate (`~`) and drift. Grep for the function name when they don't match.

## Original request (summary)
The user wants storage limits on locations. Example: when creating a storage bin, they can say it only has 4 slots. If they try to add a spool to a location that is already full, the app must not let them add it. The first step was to analyze the code and list every area that would need to change; the user then answered the open questions (see Decisions) and asked for this detailed, resumable plan.

## Goal
A storage location (e.g. a bin) can have a maximum number of spools. Adding a spool to a full location is refused.

## Decisions (all confirmed by user)
- `capacity` is an integer, default `0`, where **0 = unlimited** (matches existing app convention). Existing locations migrate to 0.
- Occupied = non-archived spools at the location. Archived spools free their slot.
- Lowering capacity below current occupancy is **blocked** (409), except setting it to 0.
- Spool create / update / bulk-create: **block** (409).
- Bulk edit (UI and `bulk-update` API): **block**, all-or-nothing.
- CSV import: **warn**, not block. The import still succeeds, and the dry-run preview and the result list the over-capacity locations.
- Un-archiving a **single** spool into a full location is **blocked** (409).
- **Bulk restore** is **allowed** even if locations go over capacity. It **warns** like CSV import, and the UI shows that warning when the restore finishes.
- A location already over capacity stays usable for **edits** of spools already in it, but nothing new can be added. The UI shows a **warning that the location exceeds its capacity**.
- Spoolman mode: **enforce too**. Capacity lives in Bambuddy's `locations` table; occupancy comes from Spoolman's spools matched by `name_key`. If Spoolman can't be reached to count, the add is refused with **503**. Capacity-0 locations skip the count and always work.
- Backup restore (GitHub backup restore, full backup ZIP restore) never enforces capacity.
- Spoolman AMS sync writes `"AMS x Ty"` as the Spoolman location when a spool is loaded, which frees its bin slot in Spoolman mode. Built-in mode keeps `location_id`, so the slot stays used. Don't enforce on AMS sync; document the difference.

## Core rule (applies everywhere)
A spool **consumes a new slot** in location L only when all of these hold after the write:
1. the spool will be non-archived, and
2. its location will be L, and
3. before the write it was **not** a non-archived spool in L (new spool, moved from elsewhere, or un-archived).

Writes where no spool consumes a new slot are always allowed. That covers editing a spool in an over-capacity location, archiving, moving a spool out, and changing other fields. Otherwise require `occupied(L) + incoming <= capacity(L)` when `capacity(L) > 0`.

---

## Phase 1 - Backend data layer
- [x] `backend/app/models/location.py` (`Location`, ~13-30): add
  `capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")`.
- [x] `backend/app/core/database.py`: in the structured-locations migration block (~5390-5420, after `ALTER TABLE locations ADD COLUMN name_key`), add
  `await _safe_execute(conn, "ALTER TABLE locations ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0")`.
  - SQLite and PostgreSQL are both supported (`is_sqlite()`, `backend/app/core/db_dialect.py`). This statement is valid on both, so no dialect branch is needed.
  - Leave the `CREATE TABLE IF NOT EXISTS locations` blocks as they are. Fresh installs get the column from the model via `create_all`.
- [x] `backend/app/schemas/location.py`:
  - `LocationCreate` (~9): `capacity: int = Field(0, ge=0)`.
  - `LocationUpdate` (~19): `capacity: int | None = Field(None, ge=0)`. It subclasses `IgnoresNullForRequiredColumns`, so a null is ignored. Check that this helper treats `capacity` as a required column, or add it.
  - `LocationResponse` (~32): add `capacity: int`, next to the existing `spool_count`.
- [x] `backend/app/api/routes/inventory.py` `_location_to_response` (~713): pass `capacity=location.capacity`.

## Phase 2 - Capacity service logic (`backend/app/services/location_service.py`)
Note: `prepare_internal_spool_payload(db, data, fields_set)` (~169) has no spool context (no spool id, no current location), so **do not** put the check inside it. Add a separate helper that routes call after `prepare_internal_spool_payload`.

- [x] Add the exception. It must **not** subclass `ValueError`, because every spool route already maps `ValueError` to 400.
  ```python
  class LocationFullError(Exception):
      def __init__(self, location: Location, occupied: int, incoming: int): ...
      def to_detail(self) -> dict:  # {"code": "location_full", "message": "...", "location_id", "location_name", "capacity", "occupied", "incoming"}
  ```
- [x] Add the shared warning model, a pydantic `BaseModel`. **Deviation:** it lives in `location_service.py`, not `schemas/location.py`, because the schema module imports the service (circular). Later phases import it from the service:
  `CapacityWarning(location_id: int, location_name: str, capacity: int, occupied: int, over_by: int)` (plus `incoming: int = 0` for CSV preview).
- [x] Add `async def ensure_location_has_room(db, location_id: int | None, *, incoming: int) -> None`.
  - Return immediately if `location_id` is None, `incoming <= 0`, or `location.capacity == 0`.
  - Otherwise use `count_internal_spools_at_location` (~203). Raise `LocationFullError` if `occupied + incoming > capacity`.
- [x] Add `async def internal_capacity_warnings(db, location_ids: Iterable[int]) -> list[CapacityWarning]`. It returns the locations with `capacity > 0` and `occupied > capacity`, and is used after bulk restore.
- [x] Spoolman-mode counting:
  - **Deviation:** `_spool_counts_for_locations` stays in `inventory.py` (existing tests patch `inventory._ensure_spoolman_client`; moving it would break those patches). Only the pure counting loop moved, as `count_spoolman_spools_by_location_key(spools)` in the service, and `inventory.py` now calls it. Original step: move `_spool_counts_for_locations` from `backend/app/api/routes/inventory.py` (~663-707) into `location_service.py` as `spool_counts_for_locations(db, locations, settings, *, strict=False)`. Update the existing callers in `inventory.py` (list ~722, update ~810, delete ~827).
  - It depends on `_spoolman_is_enabled` and `_ensure_spoolman_client`. Import them from where they live, which is probably `_spoolman_helpers.py` or `spoolman.py`; grep. If that creates an import cycle, pass the Spoolman client in as an argument instead.
  - Add `async def ensure_spoolman_location_has_room(db, client, location_name: str | None, *, incoming: int, spools: list[dict] | None = None)`.
    - Resolve the name to a `Location` with `get_location_by_name`. Return if it doesn't exist or has capacity 0; don't fetch from Spoolman in that case.
    - Otherwise count `get_all_spools(allow_archived=False)` by `location_name_key(spool["location"])`. Pass `spools` in to reuse one fetch across a bulk request.
    - Spoolman unreachable (no client or fetch exception): `HTTPException(503, "Spoolman is unavailable")`, the same as the strict delete path.

## Phase 3 - API routes

### 3a. Error mapping
- [x] Register an `@app.exception_handler(LocationFullError)` in `backend/app/main.py`, next to the existing `RequestValidationError` handler (~12881). It returns `JSONResponse(status_code=409, content={"detail": exc.to_detail()})`.
  - The frontend's `ApiError` (`frontend/src/api/client.ts` ~188-200) already reads `detail.code`, `detail.message` and the extra fields, the same way `QueuePage.tsx` ~2005 handles `insufficient_filament`.

### 3b. Locations catalog (`backend/app/api/routes/inventory.py`)
- [x] `create_location` (~735): save `data.capacity`.
- [x] `update_location` (~758): when `capacity` is in `model_fields_set` and is not 0, compute the count with `spool_counts_for_locations(..., strict=True)`. If the count is above the new capacity, raise `HTTPException(409, detail={"code": "capacity_below_occupancy", "message": ..., "occupied": n, "capacity": new})`.

### 3c. Internal spool routes (`backend/app/api/routes/inventory.py`)
- [x] `create_spool` (~1673): after `prepare_internal_spool_payload` (~1681), call `ensure_location_has_room(db, payload.get("location_id"), incoming=1)`. Skip it if the payload creates the spool archived; check whether `archived_at` can even be set on create.
- [x] `bulk_create_spools` (~1702): after prepare (~1712), call `ensure_location_has_room(db, payload.get("location_id"), incoming=data.quantity)`.
- [x] `update_spool` (~1740): after prepare (~1755), when `"location_id"` is in `update_data` and `update_data["location_id"] != spool.location_id` and `spool.archived_at is None`, call `ensure_location_has_room(db, update_data["location_id"], incoming=1)`. Editing a spool in place, including in an over-capacity location, does no check.
- [x] `bulk_update_spools` (~1933): it currently applies `prepared` to all spools in a loop (~1965) and commits. Before the loop, when `"location_id"` is in `prepared` and not None, count `incoming = sum(1 for s in spools.values() if s.archived_at is None and s.location_id != prepared["location_id"])` and call `ensure_location_has_room(..., incoming=incoming)`. The whole request then fails with 409 and nothing is written (all-or-nothing).
- [x] `restore_spool` (~1844): before `spool.archived_at = None`, call `ensure_location_has_room(db, spool.location_id, incoming=1)`.
- [x] Bulk restore (~2030, the function after `bulk_archive_spools`): leave the restore logic unchanged.
  - After commit, call `internal_capacity_warnings(db, {s.location_id for restored spools if s.location_id})`.
  - Add `"capacity_warnings": [...]` to the returned dict (`restored`, `already_active`, `not_found`).

### 3d. Spoolman spool routes (`backend/app/api/routes/spoolman_inventory.py`)
For each route, after `resolve_spoolman_location_string` returns `(storage_location, changed)`:
- [x] `POST /spools` (~708): if `changed` and `storage_location`, call `ensure_spoolman_location_has_room(db, client, storage_location, incoming=1)`.
- [x] `POST /spools/bulk` (~763): the same, with `incoming=<quantity field of that schema>`.
- [x] `PATCH /spools/{id}` (~859): the current spool is fetched earlier in this route; find where. If `changed`, the new name key differs from `location_name_key(current["location"])`, and the spool isn't archived, check with `incoming=1`.
- [x] `POST /spools/bulk-update` (~1282): it loops per spool and catches per-spool failures, so it is **not** atomic. Before the loop, if the update sets a location:
  - Fetch `get_all_spools(allow_archived=False)` once.
  - Count `incoming` as the listed non-archived ids whose current location key differs from the target.
  - Call `ensure_spoolman_location_has_room(..., incoming=incoming, spools=fetched)`, so a full target fails the whole request before anything is written.
- [x] `POST /spools/{id}/restore` (~1222): fetch the spool (`client.get_spool`, `services/spoolman.py` ~585). If it has a location, call `ensure_spoolman_location_has_room(..., incoming=1)` before `set_spool_archived(..., archived=False)`.
- [x] `POST /spools/bulk-restore` (~1374): it currently returns `{"restored", "errors"}`; this is a **different shape** from the internal route.
  - After the loop, fetch the non-archived spools once and compute the over-capacity locations among the restored spools' locations.
  - Add `"capacity_warnings"`.
  - Update the frontend type for this response too.

### 3e. CSV import
- [x] Confirmed gap: `import_spools_csv` (`inventory.py` ~1517) builds `Spool(**row.spool)` (~1564) without location resolution. `spool_csv.py` carries only the `storage_location` string (column list ~62), so imported spools get no `location_id`.
- [x] `backend/app/services/spool_csv.py`:
  - Add `capacity_warnings: list[CapacityWarning] = []` to `ImportPreview` (~136) and to `ImportResult` (~148).
  - In `parse_and_validate(raw_bytes, db)` (~316), after rows are built:
    - Group the valid rows by `location_name_key(row.spool["storage_location"])`.
    - For each group, look up the location **without creating it**: `resolve_location_by_name(db, name, create=False)`, because a dry run must not write.
    - For existing locations with `capacity > 0` where `occupied + incoming > capacity`, emit a `CapacityWarning` with `incoming`. New locations are capacity 0, so they get no warning.
    - Spoolman mode: there is no CSV import route in Spoolman mode (`spoolman_inventory.py` has none), so nothing to do there.
- [x] `import_spools_csv` `add_spool` (~1557):
  - Before `Spool(**...)`, run the row dict through `prepare_internal_spool_payload(db, row.spool, {"storage_location"})` when `storage_location` is set, so `location_id` is set and missing locations are created. Don't check capacity here.
  - Copy `preview.capacity_warnings` into the returned `ImportResult`.
- [x] `backend/tests/integration/test_inventory_csv.py` (~481-506): the round-trip test now also produces a `location_id` / `Location` row. Update its assertions.

### 3f. Paths audited (no change needed beyond the above)
- QR assign (`frontend/src/utils/qrAssignTarget.ts`) goes through the spool update route, so it gets the 409. Frontend handling is in Phase 4.
- `location_service.rename_location` (~233) only renames.
- `api/routes/spoolman.py` AMS sync (~442/453) writes `"AMS x Ty"` locations. Don't enforce; document (see Decisions).
- GitHub backup excludes the `locations` table (`github_backup.py` ~816, `github_restore.py` ~2008), so capacity isn't in it. The full backup ZIP copies the DB, so capacity round-trips there. Note this in the docs.

## Phase 4 - Frontend (`frontend/src`)
- [x] `api/client.ts`:
  - `StorageLocation` interface (~1929): add `capacity: number`.
  - `createLocation` / `updateLocation` (~7503/7505): add `capacity?: number` to the data type.
  - `CsvImportPreview` / `CsvImportResult` types: add `capacity_warnings: CapacityWarning[]`, plus a new `CapacityWarning` interface.
  - `bulkRestoreSpools` (~7379) and `bulkRestoreSpoolmanInventorySpools` (~7660) return types: add `capacity_warnings`.
- [x] Add a small helper (e.g. `utils/locationCapacity.ts`):
  - `isLocationFull(loc)` and `isOverCapacity(loc)`, both `capacity > 0 && spool_count >= / > capacity`.
  - `formatOccupancy(loc)`, which returns "3/4", or just the count when capacity is 0.
  - `locationFullMessage(t, apiError)`, which builds the translated text from `ApiError.code === 'location_full'` and its fields.
- [x] `components/LocationsModal.tsx`:
  - Add a number input for capacity in the create and edit rows, with min 0 and the hint "0 = unlimited".
  - Show the occupancy as "used/capacity", a "Full" badge, and an "Exceeds capacity" warning badge.
  - Show `capacity_below_occupancy` 409s as a translated error.
- [x] `components/spool-form/AdditionalSection.tsx` (~413-455, the location dropdown):
  - Disable full locations and suffix them "(full)", **except** the spool's current location.
  - When the current location is over capacity, show the inline warning "This location exceeds its capacity (6/4)".
  - Saving must still work.
- [x] `components/SpoolFormModal.tsx`:
  - Pass the current `location_id` to the section so it can make that exception.
  - The inline "create location" flow (~1372) can stay without a capacity field. It defaults to 0; capacity is set in the Locations modal.
  - On a save error with `code === 'location_full'`, show the translated toast.
- [x] `components/BulkEditSpoolsModal.tsx` (location field ~60/349/384): show the free slots next to each location option, and disable locations that don't have room for the selected spools not already in them.
  - The server rejects too-large requests anyway. Show the `location_full` toast on 409.
- [x] `components/QrAssignTargetModal.tsx`: on the `location_full` error, show the translated message.
- [x] `components/SpoolCsvImportModal.tsx`: show the preview's `capacity_warnings` as a warning list above the confirm button, and the result's warnings after the import.
- [x] `pages/InventoryPage.tsx`:
  - Single restore mutation (~949): on the `location_full` error, show the translated toast. This is next to the existing `restoreSpoolNotFound` handling at ~956.
  - `bulkRestoreMutation` (~1094): in `onSuccess`, if `capacity_warnings.length`, show a warning toast that lists the locations.
  - Location filter and column (`storage_location` column ~109/250/338/581; filter ~1413-1445): optionally show occupancy, and show a warning marker on over-capacity locations.
  - Invalidate the locations query key in `onSuccess` of the spool create, edit, bulk-edit, archive, restore and import mutations. Find the key used with `api.getLocations` and reuse it.
- [x] `pages/SettingsPage.tsx` (~629): it uses `getLocations`. Check whether it renders anything that should show capacity; most likely it only needs the type update.
- [x] Live updates: find where the `inventory_changed` WebSocket message invalidates queries (grep `inventory_changed` in `frontend/src`), and add the locations query key there too.
- [x] i18n: add keys to all 16 locales in `frontend/src/i18n/locales/`: en, de, fr, it, es, pt-BR, nl, sv, pl, uk, tr, ru, ja, ko, zh-CN, zh-TW.
  - Put the keys under the existing `locations:` block (`en.ts` ~5104) and the `inventory.storageLocation*` keys (~5377).
  - Suggested keys: `locations.capacity`, `locations.capacityHint`, `locations.full`, `locations.exceedsCapacity`, `locations.capacityBelowOccupancy`, `inventory.locationFull`, `inventory.locationFullOption`, `inventory.capacityWarningsTitle`, `inventory.capacityWarningItem`.
  - Write English first, then translate the rest. Check how other features handle untranslated keys; don't leave them missing if the project has a lint for that.

## Phase 5 - Tests
Backend (`backend/tests/`)
- [x] `unit/test_location_service.py`: `ensure_location_has_room`.
  - Capacity 0 is unlimited, an exactly full location is refused, archived spools aren't counted, and `incoming=N` works.
  - Also cover `internal_capacity_warnings` and that `LocationFullError` is not a `ValueError`.
- [x] Migration test modeled on `unit/test_location_migration.py`: the column is added with default 0 to an existing `locations` table, and the migration is idempotent.
- [x] (done in `integration/test_location_capacity_api.py`, 25 tests, instead of `test_locations_api.py`) create and update with capacity, `capacity` in the list response, lowering below occupancy is 409 `capacity_below_occupancy`, and lowering to 0 is allowed.
- [x] Internal spool routes. Find the existing spool API test file by grepping `bulk-update` in `backend/tests/integration`.
  - create into a full location: 409 `location_full`
  - bulk create with quantity larger than the free slots: 409, nothing created
  - moving a spool into a full location: 409
  - editing other fields of a spool in an over-capacity location: 200
  - bulk-update with one spool too many: 409, no spool changed
  - bulk-update that includes spools already in the target only counts the new ones
  - single restore into a full location: 409
  - bulk restore into a full location: 200 with `capacity_warnings`
- [x] `integration/test_inventory_csv.py`:
  - the dry-run preview has `capacity_warnings` and creates no locations
  - the real import succeeds, sets `location_id`, creates missing locations, and returns the warnings
- [x] `integration/test_spoolman_inventory_api.py`:
  - create, patch and bulk-update into a full location: 409
  - bulk-update is refused before any spool is written
  - single restore: 409; bulk restore: warnings
  - Spoolman unreachable with a capacity-limited target: 503
  - capacity-0 target with Spoolman unreachable: no count needed
- [x] Postgres: check CI for a Postgres test job (look in `.github/workflows`). If one exists, make sure the new migration and tests run there.

Frontend (`frontend/src/__tests__/`)
- [x] `components/LocationsModal.test.tsx`: capacity input, occupancy display, the full and exceeds badges, and the 409 error message.
- [x] `components/SpoolFormModal.test.tsx`:
  - a full location is disabled, except when it is the current location
  - an over-capacity warning is shown
  - the `location_full` toast appears
- [x] `components/BulkEditSpoolsModal.test.tsx`: free slots are shown, too-small locations are disabled, and the 409 toast appears.
- [x] `components/SpoolCsvImportModal.test.tsx`: preview and result warnings are rendered.
- [x] `pages/InventoryPage*.test.tsx`: single restore 409 toast and bulk restore warning toast.

## Phase 6 - Docs and release notes
- [x] `docs/storage-locations.md`: add a "Capacity" section covering:
  - 0 = unlimited, and that archived spools don't count
  - what blocks and what warns: CSV import and bulk restore warn; everything else blocks
  - over-capacity behaviour
  - Spoolman mode: counts come from Spoolman, and the 503 when it's unreachable
  - the AMS-sync difference between modes
  - that the GitHub backup excludes locations, so capacity isn't in it
- [x] `CHANGELOG.md`: add an entry in the current unreleased section, following the existing entry style.

## Verification
- [x] Backend: `pytest` on the touched test files, then the full suite if practical. Check `CLAUDE.md` / `pyproject.toml` for the exact command and linters (ruff).
- [x] Frontend: run the tests, typecheck and lint. Check `frontend/package.json` for the scripts.
- [x] Manual, built-in mode:
  1. Create a bin with capacity 4 and add 4 spools. The 5th is refused.
  2. Archive one spool; adding one now succeeds. Restore the archived spool into the full bin: refused.
  3. Bulk restore into the full bin: succeeds, with a warning, and the bin shows "exceeds capacity". Edit a spool in it: OK. Add another: refused.
  4. Lower the capacity below the count: refused. Set it to 0: accepted.
  5. CSV import into the full bin: the preview warns, and the import succeeds.
- [ ] Manual, Spoolman mode: the same flow, plus stopping Spoolman and confirming that adding to a limited bin gets a 503 while unlimited bins still work. (NOT run live: no Spoolman instance here; covered by the mocked-Spoolman integration tests)

## Notes / progress log
(append here per session)
- 2026-11-24: Plan reviewed against the code. Confirmed that CSV import bypasses location resolution and that Postgres is supported. Added the restore routes, the non-atomic Spoolman bulk-update, Spoolman fail-closed, AMS-sync semantics and the GitHub backup exclusion.
- 2026-11-24: All decisions confirmed by the user (see Decisions). Single restore blocks, bulk restore warns. Over-capacity locations allow edits but no additions, with a UI warning. Spoolman mode returns 503 when unreachable.
- 2026-11-24: Made the plan detailed enough to implement:
  - exact function signatures, and the decision to keep the check out of `prepare_internal_spool_payload` (it has no spool context)
  - `LocationFullError` must not subclass `ValueError`, because routes map that to 400
  - an app-level exception handler
  - a per-route recipe, including the different Spoolman bulk-restore response shape and the CSV dry run not creating locations
  - frontend files, the existing `ApiError.code` pattern, i18n keys, and concrete test cases

  No code written yet. Start at Phase 1.
- 2026-11-24: Phase 1 done. Added `Location.capacity`, the `ALTER TABLE` migration, `capacity` on `LocationCreate`/`LocationUpdate`/`LocationResponse`, and `_location_to_response`. `IgnoresNullForRequiredColumns` reads the table's columns, so a null `capacity` in PATCH is ignored automatically. Only `py_compile` was run: this machine has no Python env with pytest/sqlalchemy (no venv in the repo), so the existing location tests were NOT run. Set one up (e.g. `uv`) before Phase 2. `create_location` does not save `capacity` yet; that is step 3b.
  Next: Phase 2.
- 2026-11-24: Reviewed Phase 1, and no changes were needed.
  - `server_default="0"` matters: the migration's backfill `INSERT INTO locations (name, name_key, ...)` and the Postgres backup restore (raw `text()` inserts, see `test_restore_schema_compat.py`) don't list `capacity`, and they rely on the DB default.
  - SQLite allows `ADD COLUMN ... NOT NULL DEFAULT 0`. `_safe_execute` adds `IF NOT EXISTS` on Postgres.
  - Until 3b, `POST`/`PATCH /locations` accept `capacity` but silently ignore it, because both routes set fields explicitly and nothing writes `capacity`. This is safe, but don't ship before 3b.
  - `LocationResponse` is only built in `_location_to_response`.
  - No test asserts the exact set of response keys.
- 2026-11-24: Phase 2 done in `location_service.py`: `LocationFullError` (not a `ValueError`), `CapacityWarning`, `ensure_location_has_room`, `internal_capacity_warnings`, `count_spoolman_spools_by_location_key`, `ensure_spoolman_location_has_room`.
  - Deviations: `CapacityWarning` lives in the service (the schema module imports the service), and `_spool_counts_for_locations` stays in `inventory.py` so existing test patches keep working.
  - Since the Spoolman helper takes an already-resolved client, 3d routes should get it from `spoolman_inventory.py`'s own client helper and pass it in; `None` means 503 when the target has a capacity.
  - Tests: 9 new cases in `unit/test_location_service.py`. A test env exists at `/private/tmp/claude-502/venv-bb` (made with `uv venv` + `requirements*.txt`; may be cleared). Run with `PYTHONPATH=. <venv>/bin/python -m pytest ...`. Location unit/migration/API tests: 55 passed, which also verifies Phase 1.
  - Next: Phase 3a (exception handler in `main.py`).
- 2026-11-24: Reviewed Phase 2 and fixed three things:
  - The `LocationFullError` message said "is full" even when some room was left (e.g. 2/4 with 3 incoming). It now says "only has room for N more" in that case, and `to_detail()` has a new `free` field for the UI.
  - `ensure_spoolman_location_has_room` caught any `Exception` as "unavailable". It now catches only `SpoolmanUnavailableError`/`SpoolmanClientError`/`httpx.HTTPError` (503), so a code bug shows as a 500 instead of being hidden. This matches `sync_locations_from_spoolman`.
  - Tests: replaced the deprecated `datetime.utcnow()`, and added a partial-room test. 56 passed.
  - Known limit, not fixed: the check-then-write is not atomic. Two concurrent adds to the last free slot can both pass, which is unlikely in single-user use. To harden it later, re-check after `flush` in the same transaction.
- 2026-11-24: Phase 3 done (3a-3f).
  - 3a: `LocationFullError` handler in `main.py` returns 409.
  - 3b: location create saves `capacity`; PATCH refuses a lowered or newly set limit below occupancy with 409 `capacity_below_occupancy`. A raise or a set-to-0 is never counted.
  - 3c: internal spool routes (create, bulk create, update, bulk-update, single restore, bulk restore) as planned. `capacity_warnings` is added to the internal bulk-restore response.
  - 3d: Spoolman routes. The location check now runs BEFORE `_resolve_filament_id` in both create routes, so a refused create leaves no orphan vendor or filament in Spoolman. Bulk-update does one up-front count (a ContextVar `_capacity_prechecked` stops the per-spool PATCH loop re-fetching Spoolman once per spool). Single restore fetches the spool first. Bulk restore adds `capacity_warnings` and ignores a failed count, because the restore already happened.
  - 3e: CSV preview and result carry `capacity_warnings`. The dry run uses `resolve_location_by_name(create=False)`, so it writes nothing. The import resolves `storage_location` through `prepare_internal_spool_payload`, so imported spools now get a `location_id`.
  - Service additions: `fetch_active_spoolman_spools` (503 on failure) and `spoolman_capacity_warnings`.
  - Tests: new `integration/test_location_capacity_api.py` (25) and the existing location, CSV, bulk and Spoolman suites (305 total) pass. Phase 5 still has the migration test, a few extra unit cases, a CSV round-trip assertion update (not needed: the existing test passed), and the Postgres CI check.
  - Next: Phase 4 (frontend).
- 2026-11-24: Phase 3 review fix: Spoolman bulk-update now reports a `LocationFullError` inside the loop as a per-row 409 error instead of a 500 (cannot fire today because of the up-front check; defensive). Full backend run (`-x`): 6119 passed, then stopped at 2 pre-existing, unrelated `test_security.py::TestTOTPDecryptionBroken` failures (pyotp "Secrets must be at least 112 bits" in this venv).
- 2026-11-24: Phase 4 done (frontend).
  - `client.ts`: `capacity` on `StorageLocation`, `CapacityWarning` type, `capacity_warnings` on CSV preview/result and both bulk-restore returns, `capacity` on create/update location.
  - New `utils/locationCapacity.ts`: `isLocationFull`, `isOverCapacity`, `freeSlots`, `formatOccupancy`, `capacityErrorMessage` (translates `location_full` / `capacity_below_occupancy`), `capacityWarningsSummary`.
  - `LocationsModal`: capacity input (0 = unlimited), "used/capacity", Full and Exceeds-capacity badges, translated 409 on save.
  - `AdditionalSection` / `SpoolFormModal`: full locations disabled and suffixed "(full)" except the spool's own; over-capacity inline warning; archived spools exempt; translated `location_full` toast on create, bulk create and update.
  - `BulkEditSpoolsModal`: option label shows free slots; disabled when the selected active spools not already there don't fit. `InventoryPage` computes the per-location selection counts.
  - `InventoryPage`: single restore and bulk update show the translated 409; bulk restore shows a warning toast; location filter shows `used/capacity` with a marker when over.
  - `QrAssignTargetModal`, `SpoolCsvImportModal` (preview warnings list + post-import toast): done. `SettingsPage` only needs the type (no change). Live updates: `inventory_changed` already invalidates the locations key (no change needed).
  - i18n: 14 new keys in all 16 locales (sv uses "Fullt" so it differs from en). `check:i18n` passes, `tsc -b` clean, eslint clean on touched files (2 pre-existing warnings in `FilamentHoverCard.tsx`).
  - Not done: frontend tests (Phase 5). Full vitest run was started and not yet reviewed.
  - Next: Phase 5 (tests).
- 2026-11-24: Phase 4 review.
  - Fixed: CSV import's `onImported` only invalidated the spool list, so location occupancy went stale after an import. It now calls `refreshSpoolQueries()` (spools + locations).
  - Fixed: the CSV preview warning said "would hold {{occupied}}", but the preview's `occupied` is the pre-import count. The modal now passes `occupied + incoming`. (Post-import and bulk-restore warnings are already post-write counts.)
  - Fixed: a full location preselected on a new spool (copy mode copies `location_id`) stayed selectable with no hint, and the save then failed. The form now shows the "is full" message under the dropdown when the selected location is full and isn't the spool's own.
  - Hardened: `LocationsModal` edit uses `capacity ?? 0`, so stale cached data without the field doesn't parse "undefined".
  - Verified: `spool_count` from `GET /inventory/locations` counts only non-archived spools in both modes, so the frontend's full/over checks match the backend rule. `tsc -b`, eslint, `check:i18n` and the 37 related vitest files (335 tests) pass.
- 2026-11-24: Phase 5 done (tests).
  - Backend: `unit/test_location_service.py` already covered `ensure_location_has_room`, `internal_capacity_warnings` and the not-a-`ValueError` rule (Phase 2). Added two migration tests to `unit/test_location_migration.py` (column added with default 0 and a raw insert gets 0; idempotent and keeps values) and an integration test for bulk restore into a full location (200 + `capacity_warnings`). Spool route, CSV and Spoolman cases live in `integration/test_location_capacity_api.py` (26 tests) instead of the files the plan named.
  - Fixed a pre-existing breakage: `test_location_migration.py` listed its models by hand, so 4 of its tests failed (`bug_reports`, `active_print_sessions` missing). `_register_all_models` now imports every module in `backend.app.models`.
  - Postgres: the `PostgreSQL Upgrade Check` job in `ci.yml` builds an old-release DB, upgrades it and diffs the schema against a fresh install, so the new `capacity` column (type, NOT NULL, default) is covered with no change. Not run locally (needs a Postgres server and release tags).
  - Frontend: new `utils/locationCapacity.test.ts` (12), `components/BulkEditSpoolsModalCapacity.test.tsx` (3), `pages/InventoryPageRestoreCapacity.test.tsx` (2); added cases to `AdditionalSection.test.tsx` (6), `SpoolFormModal.test.tsx` (3), `SpoolCsvImportModal.test.tsx` (3), `InventoryPageWiring.test.tsx` (bulk-edit 409 toast, both modes). `LocationsModal.test.tsx` was done in Phase 4.
  - Results: 40 related frontend test files / 366 tests pass; `tsc -b` and eslint clean; backend location/CSV subset 112 passed; ruff clean.
  - Next: Phase 6 (docs and CHANGELOG).
- 2026-11-24: Phase 5 review. Every Phase 5 item maps to a passing test. Tightened four spots:
  - `test_ensure_room_partial_room_message` now also checks that exactly filling the free slots is allowed (the `incoming == free` boundary).
  - The CSV import test now asserts each imported spool's `location_id` directly, not only through the location's `spool_count`.
  - The `AdditionalSection` "own location stays selectable" test now has the form pointing at another location, so it tests `currentLocationId` alone (before, the `formData.location_id` exception also made it pass).
  - Added `test_bulk_update_reports_a_per_row_location_full_as_409`, which covers the Phase 3 review fix (Spoolman bulk-update turns a per-row `LocationFullError` into a 409 row error, not a 500).
  - Results: location service + capacity API 67 passed; `AdditionalSection` 9 passed; ruff clean.
- 2026-11-24: Edge-case pass.
  - Bug fixed (frontend): the Locations modal turned any invalid capacity (`-3`, `abc`, empty) into 0 = unlimited without a word, and cut `2.7` to 2. It now accepts only whole numbers 0..100000, shows a red field error (`locations.capacityInvalid`, all 16 locales) and disables Save.
  - Hardening (backend): `LocationCreate`/`LocationUpdate.capacity` now have `le=MAX_LOCATION_CAPACITY` (100000) so a huge value is a 422, not a 32-bit INTEGER overflow (500) on PostgreSQL. The frontend has the same constant in `utils/locationCapacity.ts`. Mention the limit in the Phase 6 docs.
  - New backend tests (`integration/test_location_capacity_api.py`, now 47): never-refused rules (move out, clear, archived spool moves into a full location but can't be restored, restoring an active spool, bulk-update ignores archived spools, bulk edits/same-location/clear on an over-capacity location); exact-fit bulk create and bulk-update; PATCH rename+lower refused with the name kept, `null` capacity ignored, `2.5`/`-1`/`100001`/`"lots"` are 422; CSV case variants group into one location, error rows don't count, one warning per location; Spoolman location PATCH (409 with Spoolman's count, 503 on lowering when unreachable, raising and 0 still fine), bulk restore when the count fails, non-ASCII names counted by key. The Spoolman fixture now also patches `inventory._ensure_spoolman_client`, which the location routes use.
  - `unit/test_location_migration.py`: guard that `capacity` keeps a server default of 0 and NOT NULL (the PostgreSQL restore of an older backup inserts rows without the column).
  - New frontend tests: LocationsModal invalid input (4 cases) and loading the current capacity; QR assign storage-target 409 shown translated in the dialog; SpoolFormModal Spoolman-mode own-location match by name and bulk-create partial-room toast; InventoryPageWiring bulk-restore warning toast and the location filter's `used/capacity` + ⚠ label (both run in built-in and Spoolman mode).
  - Left as known gaps: concurrent adds racing for the last slot (documented); the AMS sync not enforcing capacity (by design); Spoolman bulk-update showing only "N failed" for a per-row 409.
  - Results: 40 related frontend files / 378 tests; backend location, CSV and Spoolman inventory suites 315 passed; tsc, eslint, ruff and check:i18n clean.
- 2026-11-24: Phase 6. Added the Capacity section to `docs/storage-locations.md` (limit, rules, block/warn table, over-capacity, Spoolman, known limits) and an `[Unreleased]` entry in `CHANGELOG.md` (1.3.2 is already tagged, so there was no open section). The Verification manual checks remain.
- 2026-11-24: Verification. Backend capacity/location/CSV/inventory subset 904 passed (the earlier full run was 6119 passed, 1 failed; the failure was not re-investigated here); ruff check/format clean; tsc clean; eslint 0 errors (2 old FilamentHoverCard warnings); i18n parity OK; 37 related vitest files / 361 tests passed. Built-in manual flow run against a live uvicorn with a temp DATA_DIR: 5th spool 409; archive then add OK; restore into full 409; bulk restore OK with warning (5/4); edit OK; add 409; lowering below count 409; 0 accepted; 100001 gives 422; CSV preview and import warn but succeed (7/4). Spoolman live flow not run (no Spoolman instance).
- 2026-11-24: Final review of the whole feature (b1722b11d..HEAD plus docs).
  - Backend: every spool write path that can put a spool in a location is checked (create, bulk create, update, bulk-update, single restore in both modes) or warns (CSV import, bulk restore). Left out by design: AMS tag-matcher spool creation and GitHub/backup restore. In Spoolman mode, location counts exclude archived spools, the same as the backend check. All i18n keys the code uses exist in `en`.
  - CHANGELOG fixed: it said "wiki updated" (the wiki is a separate repo, not done), and it said QR assign shows free slots (it only translates the 409).
  - Full backend suite with xdist: 20154 passed, 14 failed, 2 errors, none in location code. The 2 TOTP failures are known. The other 12 (network_utils, fd_limit, restore_schema_compat, mid_print_spool_swap, mqtt_reconnect_replay) also fail on the pre-feature commit `b1722b11d~1`, so they are environmental or already there. The 2 errors were not looked into.
  - Still open: a live Spoolman manual run, and the companion wiki PR.
