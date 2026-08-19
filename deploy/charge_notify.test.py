#!/usr/bin/env python3
"""
Tests for the two halves of charge_notify.py with consequences: the re-arm,
which commands the car, and the charge-location recording, which is the one
fact about a session that cannot be recovered if this poll gets it wrong.

    python deploy/charge_notify.test.py

Standard library only, and nothing here touches the network or a real bridge:
`rearm_schedule` is replaced with a recorder in every test. What is under test
is the *decision* — whether a command goes out at all, on which poll, and how
often — because that is the half with consequences. A missed re-arm is a car
that charges the moment it is plugged in; a spurious one is a car that refuses
to charge when someone standing at it has just said it should.

charge_notify.py imports pywebpush at module load, which is a pip install this
file has no need of, so a stub stands in for it if it is not there. The
notification path is not what is being tested.
"""

from __future__ import annotations

import sys
import types
import unittest
import urllib.error
from pathlib import Path

if "pywebpush" not in sys.modules:
    try:
        import pywebpush  # noqa: F401
    except ImportError:
        stub = types.ModuleType("pywebpush")
        stub.WebPushException = type("WebPushException", (Exception,), {})
        stub.webpush = lambda **_: None
        sys.modules["pywebpush"] = stub

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The VAPID keys are read at import time; the tests never send a push.
import os  # noqa: E402

os.environ.setdefault("VAPID_PRIVATE_KEY", "test")
os.environ.setdefault("VAPID_SUBJECT", "mailto:test@example.com")

import charge_notify  # noqa: E402

VIN = "VR3UKZKXZMJ000000"
HOUR = "00:30"


class RearmTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sent = 0
        self.answer = True
        self.real_rearm = charge_notify.rearm_schedule
        charge_notify.rearm_schedule = self._rearm
        self.addCleanup(setattr, charge_notify, "rearm_schedule", self.real_rearm)

    def _rearm(self, vin: str) -> bool:
        self.assertEqual(vin, VIN)
        self.sent += 1
        return self.answer

    def poll(self, session: dict, status: str, hour: str | None = HOUR, enabled: bool = True) -> dict:
        """One poll's worth of the plug-state logic, as poll_once calls it."""
        return charge_notify.rearm_on_unplug(VIN, status, hour, session, enabled)

    def test_unplug_after_charging_rearms_once(self):
        session = self.poll({}, "inprogress")
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 1, "the unplug edge should send exactly one re-arm")

        # Days on the drive. The car is still unplugged, and nothing more is
        # sent to it.
        for _ in range(5):
            session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 1)

    def test_first_poll_never_rearms(self):
        """A watcher started next to an already-unplugged car sends nothing."""
        session = self.poll({}, "disconnected")
        self.assertEqual(self.sent, 0)
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 0)

    def test_every_unplug_gets_its_own_rearm(self):
        session = self.poll({}, "stopped")
        session = self.poll(session, "disconnected")
        session = self.poll(session, "inprogress")  # plugged in again
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 2)

    def test_plugged_in_is_left_alone(self):
        """Nothing is sent while the cable is in — that is the whole point of
        choosing the unplug edge, so a charge-now pressed at the car stands."""
        session = {}
        for status in ("stopped", "inprogress", "finished", "stopped"):
            session = self.poll(session, status)
        self.assertEqual(self.sent, 0)

    def test_no_stored_hour_sends_nothing(self):
        session = self.poll({}, "inprogress", hour=None)
        session = self.poll(session, "disconnected", hour=None)
        self.assertEqual(self.sent, 0, "a car holding no hour has nothing to re-arm")
        self.assertFalse(session.get("rearm_due"), "and should not keep trying to")

    def test_disabled_in_settings_sends_nothing(self):
        session = self.poll({}, "inprogress", enabled=False)
        session = self.poll(session, "disconnected", enabled=False)
        self.assertEqual(self.sent, 0)
        # Turning it on later must not fire a command about an old unplug.
        session = self.poll(session, "disconnected", enabled=True)
        self.assertEqual(self.sent, 0)

    def test_failure_retries_then_gives_up(self):
        self.answer = False
        session = self.poll({}, "inprogress")
        for _ in range(6):
            session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, charge_notify.MAX_REARM_ATTEMPTS)

    def test_retry_stops_as_soon_as_one_succeeds(self):
        self.answer = False
        session = self.poll({}, "inprogress")
        session = self.poll(session, "disconnected")
        self.answer = True
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 2)
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 2, "a successful re-arm ends the unplug's attempts")

    def test_unreadable_status_is_not_an_unplug(self):
        """A payload with no charging status says nothing about the cable."""
        session = self.poll({}, "inprogress")
        session = self.poll(session, None)
        self.assertEqual(self.sent, 0)
        session = self.poll(session, "disconnected")
        self.assertEqual(self.sent, 1)

    def test_unknown_status_counts_as_plugged(self):
        """An unforeseen status must not read as 'no cable' and fire a re-arm."""
        session = self.poll({}, "inprogress")
        session = self.poll(session, "somethingnew")
        self.assertEqual(self.sent, 0)


class HourParsingTest(unittest.TestCase):
    """The same shape and the same traps as hhmmFromDuration in api/client.ts."""

    def test_reads_the_stored_hour(self):
        self.assertEqual(charge_notify.hour_from_duration("PT23H"), "23:00")
        self.assertEqual(charge_notify.hour_from_duration("PT22H30M"), "22:30")
        self.assertEqual(charge_notify.hour_from_duration("PT30M"), "00:30")

    def test_no_hour_at_all_is_not_midnight(self):
        self.assertIsNone(charge_notify.hour_from_duration("PT0S"))
        self.assertIsNone(charge_notify.hour_from_duration(""))
        self.assertIsNone(charge_notify.hour_from_duration(None))
        self.assertIsNone(charge_notify.hour_from_duration(0))


class PositionParsingTest(unittest.TestCase):
    """GeoJSON's [lon, lat] order, and the shapes that are not a position."""

    def test_reads_lat_lon_from_geojson_order(self):
        info = {"last_position": {"geometry": {"coordinates": [-1.4701, 53.3811, 68]}}}
        self.assertEqual(charge_notify.position_from_info(info), (53.3811, -1.4701))

    def test_null_island_is_the_no_fix_sentinel(self):
        info = {"last_position": {"geometry": {"coordinates": [0, 0]}}}
        self.assertIsNone(charge_notify.position_from_info(info))

    def test_missing_or_malformed_is_no_position(self):
        self.assertIsNone(charge_notify.position_from_info({}))
        self.assertIsNone(charge_notify.position_from_info({"last_position": {}}))
        self.assertIsNone(
            charge_notify.position_from_info({"last_position": {"geometry": {"coordinates": [1.0]}}})
        )
        self.assertIsNone(
            charge_notify.position_from_info(
                {"last_position": {"geometry": {"coordinates": ["1.0", "2.0"]}}}
            )
        )


class ChargeLocationTest(unittest.TestCase):
    """
    What gets written to the shared blob on a start edge.

    `http_put` is replaced with a recorder — what matters here is the decision
    and the payload, not the transport. The dedupe rules have to match
    src/chargeLocations.ts, since the app appends to the same list.
    """

    HOME = (53.3811, -1.4701)
    NOW = 1_700_000_000_000

    def setUp(self) -> None:
        self.puts: list[dict] = []
        real_put = charge_notify.http_put
        charge_notify.http_put = lambda url, body: self.puts.append(body)
        self.addCleanup(setattr, charge_notify, "http_put", real_put)

    def written(self) -> list[dict]:
        self.assertEqual(len(self.puts), 1, "exactly one write per recorded charge")
        return self.puts[0]["chargeLocations"]

    def test_records_the_start(self):
        charge_notify.record_charge_location({}, self.HOME, self.NOW)
        self.assertEqual(
            self.written(), [{"at": self.NOW, "lat": 53.3811, "lon": -1.4701}]
        )

    def test_no_position_writes_nothing(self):
        charge_notify.record_charge_location({}, None, self.NOW)
        self.assertEqual(self.puts, [], "a car with no fix has nothing to record")

    def test_the_same_start_seen_twice_is_recorded_once(self):
        """The app and this watcher both notice one charge starting."""
        settings = {"chargeLocations": [{"at": self.NOW - 60_000, "lat": 53.3811, "lon": -1.4701}]}
        charge_notify.record_charge_location(settings, self.HOME, self.NOW)
        self.assertEqual(self.puts, [])

    def test_a_different_place_is_a_different_charge(self):
        """Minutes later and a mile away is a second charge, not a duplicate."""
        settings = {"chargeLocations": [{"at": self.NOW - 60_000, "lat": 53.40, "lon": -1.50}]}
        charge_notify.record_charge_location(settings, self.HOME, self.NOW)
        self.assertEqual(len(self.written()), 2)

    def test_the_same_place_tomorrow_is_a_different_charge(self):
        yesterday = self.NOW - 24 * 60 * 60 * 1000
        settings = {"chargeLocations": [{"at": yesterday, "lat": 53.3811, "lon": -1.4701}]}
        charge_notify.record_charge_location(settings, self.HOME, self.NOW)
        self.assertEqual(len(self.written()), 2)

    def test_oldest_are_dropped_at_the_cap(self):
        cap = charge_notify.MAX_CHARGE_LOCATIONS
        existing = [
            {"at": self.NOW - (cap - i) * 86_400_000, "lat": 50.0 + i / 1000, "lon": 0.0}
            for i in range(cap)
        ]
        charge_notify.record_charge_location({"chargeLocations": existing}, self.HOME, self.NOW)
        written = self.written()
        self.assertEqual(len(written), cap)
        self.assertEqual(written[-1]["at"], self.NOW)
        self.assertNotIn(existing[0], written, "the oldest entry is the one that goes")

    def test_junk_entries_are_dropped_rather_than_carried(self):
        settings = {"chargeLocations": ["nonsense", {"at": "soon"}, {"lat": 1, "lon": 2}]}
        charge_notify.record_charge_location(settings, self.HOME, self.NOW)
        self.assertEqual(len(self.written()), 1)

    def test_a_store_that_will_not_take_it_is_not_retried(self):
        def refuse(url, body):
            raise urllib.error.URLError("down")

        charge_notify.http_put = refuse
        charge_notify.record_charge_location({}, self.HOME, self.NOW)  # must not raise


class SettingDefaultTest(unittest.TestCase):
    def test_absent_means_on(self):
        self.assertTrue(charge_notify.rearm_enabled({}))
        self.assertTrue(charge_notify.rearm_enabled({"rearmScheduleOnUnplug": True}))

    def test_only_an_explicit_false_turns_it_off(self):
        self.assertFalse(charge_notify.rearm_enabled({"rearmScheduleOnUnplug": False}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
