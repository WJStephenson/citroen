#!/usr/bin/env python3
"""
Tests for the re-arm half of charge_notify.py, the part that commands the car.

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


class SettingDefaultTest(unittest.TestCase):
    def test_absent_means_on(self):
        self.assertTrue(charge_notify.rearm_enabled({}))
        self.assertTrue(charge_notify.rearm_enabled({"rearmScheduleOnUnplug": True}))

    def test_only_an_explicit_false_turns_it_off(self):
        self.assertFalse(charge_notify.rearm_enabled({"rearmScheduleOnUnplug": False}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
