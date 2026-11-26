"""Storage location capacity limits: API behaviour (docs/plans/storage-location-capacity.md)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

INV = "/api/v1/inventory"
SM = "/api/v1/spoolman/inventory"


async def _location(client: AsyncClient, name: str, capacity: int) -> dict:
    resp = await client.post(f"{INV}/locations", json={"name": name, "capacity": capacity})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _spool(client: AsyncClient, location_id: int | None) -> dict:
    resp = await client.post(f"{INV}/spools", json={"material": "PLA", "location_id": location_id})
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
@pytest.mark.integration
class TestLocationCatalog:
    async def test_capacity_is_saved_and_listed(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 4)
        assert loc["capacity"] == 4
        listed = (await async_client.get(f"{INV}/locations")).json()
        assert [row["capacity"] for row in listed if row["id"] == loc["id"]] == [4]

    async def test_capacity_defaults_to_unlimited_and_rejects_negative(self, async_client: AsyncClient):
        resp = await async_client.post(f"{INV}/locations", json={"name": "Plain"})
        assert resp.json()["capacity"] == 0
        bad = await async_client.post(f"{INV}/locations", json={"name": "Bad", "capacity": -1})
        assert bad.status_code == 422

    async def test_lowering_below_occupancy_is_refused_but_zero_is_allowed(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 4)
        for _ in range(3):
            await _spool(async_client, loc["id"])

        refused = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 2})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "capacity_below_occupancy"
        assert refused.json()["detail"]["occupied"] == 3

        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 3})).json()["capacity"] == 3
        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 0})).json()["capacity"] == 0

    async def test_setting_a_limit_on_an_unlimited_location_checks_occupancy(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 0)
        for _ in range(3):
            await _spool(async_client, loc["id"])
        resp = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 2})
        assert resp.status_code == 409


@pytest.mark.asyncio
@pytest.mark.integration
class TestInternalSpoolRoutes:
    async def test_create_into_full_location_is_409_and_not_created(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 1)
        await _spool(async_client, loc["id"])

        resp = await async_client.post(f"{INV}/spools", json={"material": "PLA", "location_id": loc["id"]})
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["code"] == "location_full"
        assert (detail["capacity"], detail["occupied"]) == (1, 1)
        listed = (await async_client.get(f"{INV}/locations")).json()
        assert [row["spool_count"] for row in listed if row["id"] == loc["id"]] == [1]

    async def test_create_by_storage_location_name_is_checked_too(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 1)
        await _spool(async_client, loc["id"])
        resp = await async_client.post(f"{INV}/spools", json={"material": "PLA", "storage_location": "bin"})
        assert resp.status_code == 409

    async def test_bulk_create_larger_than_free_slots_creates_nothing(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 4)
        await _spool(async_client, loc["id"])
        resp = await async_client.post(
            f"{INV}/spools/bulk",
            json={"spool": {"material": "PLA", "location_id": loc["id"]}, "quantity": 4},
        )
        assert resp.status_code == 409
        assert resp.json()["detail"]["free"] == 3
        ok = await async_client.post(
            f"{INV}/spools/bulk",
            json={"spool": {"material": "PLA", "location_id": loc["id"]}, "quantity": 3},
        )
        assert ok.status_code == 200

    async def test_unlimited_location_accepts_any_number(self, async_client: AsyncClient):
        loc = await _location(async_client, "Free", 0)
        for _ in range(5):
            await _spool(async_client, loc["id"])

    async def test_move_into_full_location_is_refused_but_edits_in_place_are_not(self, async_client: AsyncClient):
        bin_ = await _location(async_client, "Bin", 1)
        other = await _location(async_client, "Other", 0)
        inside = await _spool(async_client, bin_["id"])
        outside = await _spool(async_client, other["id"])

        moved = await async_client.patch(f"{INV}/spools/{outside['id']}", json={"location_id": bin_["id"]})
        assert moved.status_code == 409

        edit = await async_client.patch(f"{INV}/spools/{inside['id']}", json={"note": "x", "location_id": bin_["id"]})
        assert edit.status_code == 200

    async def test_over_capacity_location_allows_edits_but_not_additions(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 3)
        spools = [await _spool(async_client, loc["id"]) for _ in range(3)]
        # Archive one, restore it in bulk into a now-full bin -> over capacity.
        assert (await async_client.post(f"{INV}/spools/{spools[0]['id']}/archive")).status_code == 200
        await _spool(async_client, loc["id"])
        bulk = await async_client.post(f"{INV}/spools/bulk-restore", json={"ids": [spools[0]["id"]]})
        assert bulk.status_code == 200
        warnings = bulk.json()["capacity_warnings"]
        assert [(w["capacity"], w["occupied"], w["over_by"]) for w in warnings] == [(3, 4, 1)]

        edit = await async_client.patch(f"{INV}/spools/{spools[1]['id']}", json={"note": "still editable"})
        assert edit.status_code == 200
        assert (await _post_spool(async_client, loc["id"])).status_code == 409

    async def test_single_restore_into_full_location_is_409(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 1)
        first = await _spool(async_client, loc["id"])
        await async_client.post(f"{INV}/spools/{first['id']}/archive")
        await _spool(async_client, loc["id"])

        resp = await async_client.post(f"{INV}/spools/{first['id']}/restore")
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "location_full"

    async def test_bulk_restore_without_overflow_has_no_warnings(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 2)
        spool = await _spool(async_client, loc["id"])
        await async_client.post(f"{INV}/spools/{spool['id']}/archive")
        resp = await async_client.post(f"{INV}/spools/bulk-restore", json={"ids": [spool["id"]]})
        assert resp.json()["capacity_warnings"] == []

    async def test_bulk_restore_into_full_location_succeeds_with_warnings(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 1)
        archived = await _spool(async_client, loc["id"])
        await async_client.post(f"{INV}/spools/{archived['id']}/archive")
        await _spool(async_client, loc["id"])

        resp = await async_client.post(f"{INV}/spools/bulk-restore", json={"ids": [archived["id"]]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["restored"] == 1
        assert [
            (w["location_name"], w["capacity"], w["occupied"], w["over_by"]) for w in body["capacity_warnings"]
        ] == [("Bin", 1, 2, 1)]

    async def test_bulk_update_is_all_or_nothing(self, async_client: AsyncClient):
        bin_ = await _location(async_client, "Bin", 3)
        other = await _location(async_client, "Other", 0)
        already_in = await _spool(async_client, bin_["id"])
        movers = [await _spool(async_client, other["id"]) for _ in range(3)]

        too_many = await async_client.post(
            f"{INV}/spools/bulk-update",
            json={"ids": [m["id"] for m in movers], "update": {"location_id": bin_["id"]}},
        )
        assert too_many.status_code == 409
        for m in movers:
            got = (await async_client.get(f"{INV}/spools/{m['id']}")).json()
            assert got["location_id"] == other["id"]

        # Spools already in the target don't count against it.
        fits = await async_client.post(
            f"{INV}/spools/bulk-update",
            json={"ids": [already_in["id"], movers[0]["id"], movers[1]["id"]], "update": {"location_id": bin_["id"]}},
        )
        assert fits.status_code == 200, fits.text
        assert fits.json()["updated"] == 3


async def _post_spool(client: AsyncClient, location_id: int):
    return await client.post(f"{INV}/spools", json={"material": "PLA", "location_id": location_id})


@pytest.mark.asyncio
@pytest.mark.integration
class TestCsvImport:
    CSV = b"material,storage_location\nPLA,Bin\nPETG,Bin\nASA,Bin\n"

    async def _post(self, client: AsyncClient, dry_run: bool):
        return await client.post(
            f"{INV}/spools/import",
            params={"dry_run": str(dry_run).lower()},
            files={"file": ("spools.csv", self.CSV, "text/csv")},
        )

    async def test_dry_run_warns_and_creates_no_location(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 2)
        await _spool(async_client, loc["id"])
        before = len((await async_client.get(f"{INV}/locations")).json())

        resp = await self._post(async_client, True)
        assert resp.status_code == 200
        warnings = resp.json()["capacity_warnings"]
        assert [(w["capacity"], w["occupied"], w["incoming"], w["over_by"]) for w in warnings] == [(2, 1, 3, 2)]
        assert len((await async_client.get(f"{INV}/locations")).json()) == before

    async def test_import_succeeds_over_capacity_and_links_locations(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 2)
        resp = await self._post(async_client, False)
        assert resp.status_code == 200
        body = resp.json()
        assert body["created"] == 3
        assert [w["over_by"] for w in body["capacity_warnings"]] == [1]
        listed = {row["id"]: row for row in (await async_client.get(f"{INV}/locations")).json()}
        assert listed[loc["id"]]["spool_count"] == 3
        spools = (await async_client.get(f"{INV}/spools")).json()
        assert sorted(sp["material"] for sp in spools if sp["location_id"] == loc["id"]) == ["ASA", "PETG", "PLA"]

    async def test_new_location_is_created_unlimited_without_warning(self, async_client: AsyncClient):
        resp = await self._post(async_client, False)
        assert resp.json()["capacity_warnings"] == []
        names = {row["name"]: row for row in (await async_client.get(f"{INV}/locations")).json()}
        assert names["Bin"]["capacity"] == 0
        assert names["Bin"]["spool_count"] == 3


# ── Spoolman mode ───────────────────────────────────────────────────────────

SPOOL = {
    "id": 42,
    "filament": {
        "id": 7,
        "name": "PLA Basic",
        "material": "PLA",
        "color_hex": "FF0000",
        "weight": 1000,
        "vendor": {"id": 3, "name": "Bambu Lab"},
    },
    "remaining_weight": 750.0,
    "used_weight": 250.0,
    "location": None,
    "comment": None,
    "archived": False,
    "extra": {},
}


@pytest.fixture
async def spoolman(db_session):
    from backend.app.models.settings import Settings

    db_session.add(Settings(key="spoolman_enabled", value="true"))
    db_session.add(Settings(key="spoolman_url", value="http://localhost:7912"))
    await db_session.commit()

    mock = MagicMock()
    mock.base_url = "http://localhost:7912"
    mock.health_check = AsyncMock(return_value=True)
    mock.get_spool = AsyncMock(return_value=SPOOL)
    mock.get_all_spools = AsyncMock(return_value=[])
    mock.set_spool_archived = AsyncMock(side_effect=lambda spool_id, archived: {**SPOOL, "archived": archived})
    mock.update_spool_full = AsyncMock(return_value=SPOOL)
    mock.merge_spool_extra = AsyncMock(return_value=SPOOL)
    mock.is_filament_shared = AsyncMock(return_value=False)
    mock.patch_filament = AsyncMock(return_value={"id": 7})
    mock.find_or_create_filament = AsyncMock(return_value=7)
    mock.find_or_create_vendor = AsyncMock(return_value=3)
    mock.create_spool = AsyncMock(return_value=SPOOL)
    mock.ensure_extra_field = AsyncMock(return_value=True)
    mock.get_distinct_locations = AsyncMock(return_value=[])

    class _Lock:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    mock.extra_lock = lambda spool_id: _Lock()
    with (
        patch("backend.app.api.routes.spoolman_inventory.get_spoolman_client", AsyncMock(return_value=mock)),
        patch("backend.app.api.routes.spoolman_inventory.init_spoolman_client", AsyncMock(return_value=mock)),
        # The location catalog routes (inventory.py) reach Spoolman through their own helper.
        patch("backend.app.api.routes.inventory._ensure_spoolman_client", AsyncMock(return_value=mock)),
    ):
        yield mock


def _in(location: str, n: int, start: int = 100) -> list[dict]:
    return [{"id": start + i, "location": location} for i in range(n)]


@pytest.mark.asyncio
@pytest.mark.integration
class TestSpoolmanMode:
    async def test_create_into_full_location_is_409_and_nothing_is_created(self, async_client, spoolman):
        await _location(async_client, "Bin", 2)
        spoolman.get_all_spools.return_value = _in("bin", 2)
        resp = await async_client.post(f"{SM}/spools", json={"material": "PLA", "storage_location": "Bin"})
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "location_full"
        spoolman.create_spool.assert_not_awaited()
        spoolman.find_or_create_filament.assert_not_awaited()

    async def test_unlimited_and_unknown_locations_skip_the_count(self, async_client, spoolman):
        await _location(async_client, "Free", 0)
        spoolman.get_all_spools.side_effect = RuntimeError("must not be called")
        for name in ("Free", "Never created"):
            resp = await async_client.post(f"{SM}/spools", json={"material": "PLA", "storage_location": name})
            assert resp.status_code == 200, resp.text

    async def test_unreachable_spoolman_is_503_for_limited_locations(self, async_client, spoolman):
        from backend.app.services.spoolman import SpoolmanUnavailableError

        await _location(async_client, "Bin", 2)
        spoolman.get_all_spools.side_effect = SpoolmanUnavailableError("down")
        resp = await async_client.post(f"{SM}/spools", json={"material": "PLA", "storage_location": "Bin"})
        assert resp.status_code == 503

    async def test_bulk_create_that_does_not_fit_is_409(self, async_client, spoolman):
        await _location(async_client, "Bin", 4)
        spoolman.get_all_spools.return_value = _in("Bin", 2)
        resp = await async_client.post(
            f"{SM}/spools/bulk", json={"spool": {"material": "PLA", "storage_location": "Bin"}, "quantity": 3}
        )
        assert resp.status_code == 409
        spoolman.create_spool.assert_not_awaited()

    async def test_patch_move_into_full_location_is_409_but_staying_is_fine(self, async_client, spoolman):
        await _location(async_client, "Bin", 1)
        spoolman.get_all_spools.return_value = _in("Bin", 1)
        resp = await async_client.patch(f"{SM}/spools/42", json={"storage_location": "Bin"})
        assert resp.status_code == 409
        spoolman.get_spool.return_value = {**SPOOL, "location": "bin"}
        stay = await async_client.patch(f"{SM}/spools/42", json={"storage_location": "Bin", "note": "x"})
        assert stay.status_code == 200, stay.text

    async def test_bulk_update_is_refused_before_anything_is_written(self, async_client, spoolman):
        await _location(async_client, "Bin", 2)
        spoolman.get_all_spools.return_value = [
            {"id": 1, "location": "Bin"},
            {"id": 2, "location": None},
            {"id": 3, "location": None},
        ]
        resp = await async_client.post(
            f"{SM}/spools/bulk-update", json={"ids": [2, 3], "update": {"storage_location": "Bin"}}
        )
        assert resp.status_code == 409
        spoolman.update_spool_full.assert_not_awaited()

    async def test_bulk_update_reports_a_per_row_location_full_as_409(self, async_client, spoolman):
        # The up-front count normally stops this; if a row still raises, it is
        # a 409 for that row, not a 500.
        from backend.app.models.location import Location
        from backend.app.services.location_service import LocationFullError

        await _location(async_client, "Free", 0)
        full = Location(id=99, name="Bin", name_key="bin", capacity=1)

        async def update(spool_id, *args, **kwargs):
            if spool_id == 2:
                raise LocationFullError(full, occupied=1, incoming=1)
            return SPOOL

        spoolman.update_spool_full.side_effect = update
        resp = await async_client.post(
            f"{SM}/spools/bulk-update", json={"ids": [1, 2], "update": {"storage_location": "Free"}}
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["updated"] == 1
        assert [(e["id"], e["status"], e["detail"]["code"]) for e in body["errors"]] == [(2, 409, "location_full")]

    async def test_bulk_update_that_fits_goes_through(self, async_client, spoolman):
        await _location(async_client, "Bin", 3)
        spoolman.get_all_spools.return_value = [
            {"id": 1, "location": "Bin"},
            {"id": 2, "location": None},
            {"id": 3, "location": None},
        ]
        resp = await async_client.post(
            f"{SM}/spools/bulk-update", json={"ids": [1, 2, 3], "update": {"storage_location": "Bin"}}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["updated"] == 3

    async def test_single_restore_into_full_location_is_409(self, async_client, spoolman):
        await _location(async_client, "Bin", 1)
        spoolman.get_spool.return_value = {**SPOOL, "location": "Bin", "archived": True}
        spoolman.get_all_spools.return_value = _in("Bin", 1)
        resp = await async_client.post(f"{SM}/spools/42/restore")
        assert resp.status_code == 409
        spoolman.set_spool_archived.assert_not_awaited()

    async def test_bulk_restore_reports_capacity_warnings(self, async_client, spoolman):
        await _location(async_client, "Bin", 1)
        spoolman.set_spool_archived.side_effect = lambda spool_id, archived: {**SPOOL, "location": "Bin"}
        spoolman.get_all_spools.return_value = _in("Bin", 3)
        resp = await async_client.post(f"{SM}/spools/bulk-restore", json={"ids": [42]})
        assert resp.status_code == 200
        body = resp.json()
        assert body["restored"] == 1
        assert [(w["capacity"], w["occupied"], w["over_by"]) for w in body["capacity_warnings"]] == [(1, 3, 2)]


# ── Edge cases: things that must never be refused, boundaries, PATCH rules ──


@pytest.mark.asyncio
@pytest.mark.integration
class TestNeverRefused:
    async def test_moving_out_of_and_clearing_a_full_location_is_allowed(self, async_client: AsyncClient):
        full = await _location(async_client, "Full", 2)
        other = await _location(async_client, "Other", 0)
        a = await _spool(async_client, full["id"])
        b = await _spool(async_client, full["id"])

        out = await async_client.patch(f"{INV}/spools/{a['id']}", json={"location_id": other["id"]})
        assert out.status_code == 200, out.text
        cleared = await async_client.patch(f"{INV}/spools/{b['id']}", json={"location_id": None})
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["location_id"] is None

    async def test_archived_spool_can_move_into_a_full_location_but_not_be_restored(self, async_client: AsyncClient):
        full = await _location(async_client, "Full", 1)
        other = await _location(async_client, "Other", 0)
        await _spool(async_client, full["id"])
        archived = await _spool(async_client, other["id"])
        await async_client.post(f"{INV}/spools/{archived['id']}/archive")

        moved = await async_client.patch(f"{INV}/spools/{archived['id']}", json={"location_id": full["id"]})
        assert moved.status_code == 200, moved.text
        restored = await async_client.post(f"{INV}/spools/{archived['id']}/restore")
        assert restored.status_code == 409
        assert restored.json()["detail"]["code"] == "location_full"

    async def test_restoring_an_active_spool_is_never_checked(self, async_client: AsyncClient):
        full = await _location(async_client, "Full", 1)
        active = await _spool(async_client, full["id"])
        resp = await async_client.post(f"{INV}/spools/{active['id']}/restore")
        assert resp.status_code != 409

    async def test_bulk_update_does_not_count_archived_spools(self, async_client: AsyncClient):
        target = await _location(async_client, "Target", 1)
        other = await _location(async_client, "Other", 0)
        active = await _spool(async_client, other["id"])
        archived = [await _spool(async_client, other["id"]) for _ in range(3)]
        for sp in archived:
            await async_client.post(f"{INV}/spools/{sp['id']}/archive")

        resp = await async_client.post(
            f"{INV}/spools/bulk-update",
            json={"ids": [active["id"], *(sp["id"] for sp in archived)], "update": {"location_id": target["id"]}},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["updated"] == 4

    async def test_bulk_edits_and_clearing_on_an_over_capacity_location_are_allowed(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 2)
        spools = [await _spool(async_client, loc["id"]) for _ in range(2)]
        # Archive one, fill its slot, then bulk-restore it: 3 spools in a 2-slot bin.
        await async_client.post(f"{INV}/spools/{spools[0]['id']}/archive")
        spools.append(await _spool(async_client, loc["id"]))
        await async_client.post(f"{INV}/spools/bulk-restore", json={"ids": [spools[0]["id"]]})
        listed = {row["id"]: row for row in (await async_client.get(f"{INV}/locations")).json()}
        assert listed[loc["id"]]["spool_count"] == 3
        ids = [sp["id"] for sp in spools]

        note = await async_client.post(f"{INV}/spools/bulk-update", json={"ids": ids, "update": {"note": "x"}})
        assert note.status_code == 200, note.text
        same = await async_client.post(
            f"{INV}/spools/bulk-update", json={"ids": ids, "update": {"location_id": loc["id"]}}
        )
        assert same.status_code == 200, same.text
        clear = await async_client.post(f"{INV}/spools/bulk-update", json={"ids": ids, "update": {"location_id": None}})
        assert clear.status_code == 200, clear.text


@pytest.mark.asyncio
@pytest.mark.integration
class TestExactFit:
    async def test_bulk_create_that_exactly_fills_the_free_slots_succeeds(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 3)
        await _spool(async_client, loc["id"])
        resp = await async_client.post(
            f"{INV}/spools/bulk", json={"spool": {"material": "PLA", "location_id": loc["id"]}, "quantity": 2}
        )
        assert resp.status_code == 200, resp.text
        assert (await _post_spool(async_client, loc["id"])).status_code == 409

    async def test_bulk_update_that_exactly_fills_the_location_succeeds(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 2)
        other = await _location(async_client, "Other", 0)
        movers = [await _spool(async_client, other["id"]) for _ in range(2)]
        resp = await async_client.post(
            f"{INV}/spools/bulk-update",
            json={"ids": [m["id"] for m in movers], "update": {"location_id": loc["id"]}},
        )
        assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
@pytest.mark.integration
class TestLocationPatchEdges:
    async def test_rename_and_lower_in_one_request_is_refused_and_keeps_the_name(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 0)
        for _ in range(3):
            await _spool(async_client, loc["id"])
        resp = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"name": "Renamed", "capacity": 2})
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "capacity_below_occupancy"
        listed = {row["id"]: row for row in (await async_client.get(f"{INV}/locations")).json()}
        assert (listed[loc["id"]]["name"], listed[loc["id"]]["capacity"]) == ("Bin", 0)

    async def test_null_capacity_is_ignored(self, async_client: AsyncClient):
        loc = await _location(async_client, "Bin", 4)
        resp = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": None, "name": "Bin 2"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["capacity"] == 4

    @pytest.mark.parametrize("bad", [2.5, -1, 100_001, "lots"])
    async def test_invalid_capacity_is_422(self, async_client: AsyncClient, bad):
        created = await async_client.post(f"{INV}/locations", json={"name": "Bin", "capacity": bad})
        assert created.status_code == 422
        loc = await _location(async_client, "Other", 0)
        patched = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": bad})
        assert patched.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestCsvEdges:
    async def _post(self, client: AsyncClient, csv: bytes, dry_run: bool):
        return await client.post(
            f"{INV}/spools/import",
            params={"dry_run": str(dry_run).lower()},
            files={"file": ("spools.csv", csv, "text/csv")},
        )

    async def test_case_variants_group_into_one_location(self, async_client: AsyncClient):
        await _location(async_client, "Bin", 1)
        csv = b"material,storage_location\nPLA,Bin\nPETG,bin\nASA,BIN\n"
        preview = (await self._post(async_client, csv, True)).json()
        assert [(w["location_name"], w["incoming"]) for w in preview["capacity_warnings"]] == [("Bin", 3)]

        result = await self._post(async_client, csv, False)
        assert result.status_code == 200, result.text
        names = [row["name"] for row in (await async_client.get(f"{INV}/locations")).json()]
        assert names.count("Bin") == 1 and "bin" not in names and "BIN" not in names

    async def test_rows_with_errors_do_not_count_as_incoming(self, async_client: AsyncClient):
        await _location(async_client, "Bin", 1)
        # Two rows have no material, so only one spool can land in Bin.
        csv = b"material,storage_location\nPLA,Bin\n,Bin\n,Bin\n"
        preview = (await self._post(async_client, csv, True)).json()
        assert preview["capacity_warnings"] == []

    async def test_each_over_capacity_location_gets_its_own_warning(self, async_client: AsyncClient):
        await _location(async_client, "A", 1)
        await _location(async_client, "B", 1)
        await _location(async_client, "C", 5)
        csv = b"material,storage_location\nPLA,A\nPLA,A\nPLA,B\nPLA,B\nPLA,C\n"
        preview = (await self._post(async_client, csv, True)).json()
        assert sorted((w["location_name"], w["over_by"]) for w in preview["capacity_warnings"]) == [("A", 1), ("B", 1)]


@pytest.mark.asyncio
@pytest.mark.integration
class TestSpoolmanEdges:
    async def test_lowering_below_spoolman_occupancy_is_409(self, async_client, spoolman):
        loc = await _location(async_client, "Bin", 0)
        spoolman.get_all_spools.return_value = _in("bin", 3)
        resp = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 2})
        assert resp.status_code == 409
        assert resp.json()["detail"]["occupied"] == 3
        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 3})).status_code == 200

    async def test_unreachable_spoolman_blocks_lowering_but_not_raising_or_clearing(self, async_client, spoolman):
        from backend.app.services.spoolman import SpoolmanUnavailableError

        loc = await _location(async_client, "Bin", 0)
        spoolman.get_all_spools.side_effect = SpoolmanUnavailableError("down")
        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 2})).status_code == 503
        # Setting it to 0 never needs a count; neither does raising an existing limit.
        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 0})).status_code == 200

        spoolman.get_all_spools.side_effect = None
        spoolman.get_all_spools.return_value = []
        assert (await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 2})).status_code == 200
        spoolman.get_all_spools.side_effect = SpoolmanUnavailableError("down")
        raised = await async_client.patch(f"{INV}/locations/{loc['id']}", json={"capacity": 5})
        assert raised.status_code == 200, raised.text

    async def test_bulk_restore_succeeds_when_the_count_fails(self, async_client, spoolman):
        from backend.app.services.spoolman import SpoolmanUnavailableError

        await _location(async_client, "Bin", 1)
        spoolman.set_spool_archived.side_effect = lambda spool_id, archived: {**SPOOL, "location": "Bin"}
        spoolman.get_all_spools.side_effect = SpoolmanUnavailableError("down")
        resp = await async_client.post(f"{SM}/spools/bulk-restore", json={"ids": [42]})
        assert resp.status_code == 200, resp.text
        assert resp.json()["restored"] == 1
        assert resp.json()["capacity_warnings"] == []

    async def test_non_ascii_location_names_are_counted_by_key(self, async_client, spoolman):
        await _location(async_client, "Ärmel Fach", 1)
        spoolman.get_all_spools.return_value = _in("ärmel fach", 1)
        resp = await async_client.post(f"{SM}/spools", json={"material": "PLA", "storage_location": "ÄRMEL FACH"})
        assert resp.status_code == 409
        assert resp.json()["detail"]["occupied"] == 1
