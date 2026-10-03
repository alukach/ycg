"""Offline tests for the parsers: python -m unittest scripts/test_fetch.py"""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fetch  # noqa: E402

TEXT_ARRIVED = """<html><body><div>AC 8376</div><div>Air Canada</div>
<div>YVR Vancouver</div><div>YCG Castlegar</div>
<div>Operated by Jazz on behalf of Air Canada</div><div>Arrived</div><div>On time</div>
<div>Flight Departure Times</div><div>02-Oct-2026</div>
<div>Scheduled</div><div>09:05 PDT</div><div>Actual</div><div>08:59 PDT</div>
<div>Flight Arrival Times</div><div>02-Oct-2026</div>
<div>Scheduled</div><div>10:14 PDT</div><div>Actual</div><div>10:02 PDT</div></body></html>"""

TEXT_CANCELLED = """<div>Operated by Jazz on behalf of Air Canada</div><div>Cancelled</div>
<div>Departure</div><div>Scheduled</div><div>10:50 PDT</div><div>Estimated</div><div>--:--</div>
<div>Arrival</div><div>Scheduled</div><div>12:05 PDT</div><div>Estimated</div><div>--:--</div>"""

TEXT_ESTIMATED = """<div>on behalf of Air Canada</div><div>Scheduled</div><div>Delayed by 25m</div>
<div>Scheduled</div><div>9:05 AM PDT</div><div>Estimated</div><div>9:30 AM PDT</div>
<div>Scheduled</div><div>10:14 AM PDT</div><div>Estimated</div><div>10:39 AM PDT</div>"""

OUT_OF_RANGE = "<div>Flight Status Not Available</div><div>DATE IS OUT OF RANGE</div>"

NEXT = {"props": {"initialState": {"flightTracker": {"flight": {
    "status": {"status": "Arrived", "statusCode": "L", "statusDescription": "Delayed by 19m"},
    "schedule": {"scheduledDeparture": "2026-10-02T10:50:00.000", "scheduledArrival": "2026-10-02T12:05:00.000",
                 "estimatedActualDeparture": "2026-10-02T10:49:00.000", "estimatedActualArrival": "2026-10-02T12:24:00.000",
                 "estimatedActualDepartureTitle": "Actual", "estimatedActualArrivalTitle": "Actual"},
    "departureAirport": {"iata": "YCG", "times": {"scheduled": {"time": "10:50", "ampm": "AM"}, "estimatedActual": {"title": "Actual", "time": "10:49", "ampm": "AM"}}},
    "arrivalAirport": {"iata": "YVR", "times": {"scheduled": {"time": "12:05", "ampm": "PM"}, "estimatedActual": {"title": "Actual", "time": "12:24", "ampm": "PM"}}},
}}}}}
NEXT_HTML = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(NEXT)}</script>'


class Parsers(unittest.TestCase):
    def test_text_arrived(self):
        r = fetch.parse_flightstats_text(TEXT_ARRIVED)
        self.assertEqual(r["status"], "arrived")
        self.assertEqual((r["sched_dep"], r["dep_time"], r["sched_arr"], r["arr_time"]), ("09:05", "08:59", "10:14", "10:02"))
        self.assertTrue(r["arr_is_actual"])
        rec = fetch.enrich(fetch.FLIGHTS[0], dt.date(2026, 10, 2), r)
        self.assertEqual(rec["outcome"], "on_time")
        self.assertEqual(rec["arr_delay_min"], -12)

    def test_text_cancelled(self):
        r = fetch.parse_flightstats_text(TEXT_CANCELLED)
        self.assertEqual(r["status"], "cancelled")
        self.assertIsNone(r["dep_time"])
        self.assertEqual(fetch.enrich(fetch.FLIGHTS[1], dt.date(2026, 10, 2), r)["outcome"], "cancelled")

    def test_text_estimated_12h(self):
        r = fetch.parse_flightstats_text(TEXT_ESTIMATED)
        self.assertEqual(r["status"], "delayed")
        self.assertEqual((r["sched_dep"], r["dep_time"], r["arr_time"]), ("09:05", "09:30", "10:39"))
        self.assertFalse(r["dep_is_actual"])
        self.assertIsNone(fetch.enrich(fetch.FLIGHTS[0], dt.date(2026, 10, 2), r)["outcome"])

    def test_out_of_range(self):
        self.assertEqual(fetch.parse_flightstats_text(OUT_OF_RANGE)["status"], "unavailable")

    def test_next_data(self):
        r = fetch.parse_flightstats_json(NEXT_HTML)
        self.assertEqual(r["status"], "arrived")
        self.assertEqual((r["sched_dep"], r["dep_time"], r["sched_arr"], r["arr_time"]), ("10:50", "10:49", "12:05", "12:24"))
        rec = fetch.enrich(fetch.FLIGHTS[1], dt.date(2026, 10, 2), r)
        self.assertEqual((rec["arr_delay_min"], rec["outcome"]), (19, "delayed"))

    def test_next_data_returned_to_origin(self):
        nxt = json.loads(json.dumps(NEXT))
        f = nxt["props"]["initialState"]["flightTracker"]["flight"]
        f["status"] = {"status": "Landed", "statusCode": "L", "diverted": True}
        f["divertedAirport"] = {"iata": "YVR"}
        r = fetch.parse_flightstats_json(f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(nxt)}</script>')
        self.assertEqual((r["status"], r["diverted_to"]), ("diverted", "YVR"))
        self.assertEqual(fetch.enrich(fetch.FLIGHTS[0], dt.date(2026, 10, 2), r)["outcome"], "diverted")

    def test_unknown_record_uses_schedule(self):
        r = fetch.unknown_record(fetch.FLIGHTS[0], dt.date(2026, 12, 15), dt.datetime(2026, 12, 20, tzinfo=fetch.TZ))
        self.assertEqual((r["outcome"], r["sched_arr"]), ("unknown", "10:14"))
        self.assertEqual(fetch.ycg_time(r, dt.date(2026, 12, 15)).isoformat(), "2026-12-15T17:14:00+00:00")  # BC is UTC-7 year-round from 2026-11-01 (tz 2026b)

    def test_tz_data_has_bc_permanent_utc7(self):
        # Fails if the runner's tz database predates 2026b (BC on UTC-7 year-round from 2026-11-01).
        self.assertEqual(dt.datetime(2026, 12, 15, 10, tzinfo=fetch.TZ).utcoffset(), dt.timedelta(hours=-7))

    def test_next_data_tail(self):
        nxt = json.loads(json.dumps(NEXT))
        nxt["props"]["initialState"]["flightTracker"]["flight"]["positional"] = {"flexTrack": {"tailNumber": "C-GGMZ", "equipment": "DH4"}}
        r = fetch.parse_flightstats_json(f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(nxt)}</script>')
        self.assertEqual((r["tail"], r["equipment"]), ("C-GGMZ", "DH4"))
        self.assertAlmostEqual(fetch.nm_between(fetch.AIRPORTS["YVR"], fetch.AIRPORTS["YCG"]), 218, delta=3)  # ~404 km

    def test_nearest_metar(self):
        metars = ["METAR CYCG 021800Z VRB02KT 15SM SCT085 15/08 A3006", "METAR CYCG 021700Z 00000KT 15SM FEW140 13/08 A3008"]
        when = dt.datetime(2026, 10, 2, 17, 14, tzinfo=dt.timezone.utc)
        self.assertIn("021700Z", fetch.nearest_metar(metars, when))


if __name__ == "__main__":
    unittest.main()
