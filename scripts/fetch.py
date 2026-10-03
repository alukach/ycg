#!/usr/bin/env python3
"""Fetch YCG flight status + aviation weather and update data/*.json.

Stdlib only. Run from the repo root:

    python scripts/fetch.py            # writes data/latest.json, updates data/history.json
    python scripts/fetch.py --debug    # also dumps raw HTML to debug/

Sources
  - Flight status: FlightStats public flight tracker pages (server-rendered HTML).
    Optional fallback: AeroDataBox via RapidAPI when AERODATABOX_KEY is set.
  - METAR / TAF: aviationweather.gov data API (raw text).
"""
from __future__ import annotations

import argparse
import datetime as dt
import html as htmllib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Vancouver")
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DEBUG = ROOT / "debug"

FLIGHTS = [
    # number, origin, destination, direction relative to YCG
    {"flight": "AC8376", "carrier": "AC", "number": "8376", "from": "YVR", "to": "YCG", "kind": "arrival"},
    {"flight": "AC8377", "carrier": "AC", "number": "8377", "from": "YCG", "to": "YVR", "kind": "departure"},
]
STATION = "CYCG"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
FINAL = {"arrived", "landed", "cancelled", "diverted"}


# --------------------------------------------------------------------------- http

def get(url: str, headers: dict | None = None, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-CA,en;q=0.9", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


# ------------------------------------------------------------------ flightstats

STATUS_WORDS = [
    ("cancel", "cancelled"),
    ("divert", "diverted"),
    ("arrived", "arrived"),
    ("landed", "arrived"),
    ("en route", "en_route"),
    ("en-route", "en_route"),
    ("departed", "en_route"),
    ("delayed", "delayed"),
    ("scheduled", "scheduled"),
]
STATUS_CODES = {"A": "en_route", "L": "arrived", "C": "cancelled", "NO": "cancelled", "D": "diverted", "S": "scheduled", "R": "diverted", "U": "unknown"}


def norm_status(text: str | None) -> str:
    t = (text or "").lower()
    for needle, val in STATUS_WORDS:
        if needle in t:
            return val
    return "unknown"


def to_24h(t: str | None) -> str | None:
    """'9:05 AM' / '09:05' / '21:05' -> 'HH:MM'. Returns None for blanks/--."""
    if not t:
        return None
    t = t.strip()
    m = re.match(r"^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$", t)
    if not m:
        return None
    h, mi, ap = int(m.group(1)), m.group(2), (m.group(3) or "").upper()
    if ap == "PM" and h != 12:
        h += 12
    if ap == "AM" and h == 12:
        h = 0
    return f"{h:02d}:{mi}"


def _walk(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _time_from(node) -> str | None:
    """Accepts {'time24': '09:05'} | {'time': '9:05', 'ampm': 'AM'} | ISO string."""
    if node is None:
        return None
    if isinstance(node, str):
        m = re.search(r"T(\d{2}):(\d{2})", node)
        return f"{m.group(1)}:{m.group(2)}" if m else to_24h(node)
    if isinstance(node, dict):
        if node.get("time24"):
            return to_24h(node["time24"])
        if node.get("time"):
            return to_24h(f"{node['time']} {node.get('ampm', '')}".strip())
    return None


def parse_flightstats_json(page: str) -> dict | None:
    """Parse the embedded Next.js state, if present."""
    blobs = []
    m = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if m:
        blobs.append(m.group(1))
    m = re.search(r"__NEXT_DATA__\s*=\s*(\{.*?\})\s*;?\s*__NEXT_LOADED_PAGES__", page, re.S)
    if m:
        blobs.append(m.group(1))
    for blob in blobs:
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        for d in _walk(data):
            if not (isinstance(d, dict) and "departureAirport" in d and "arrivalAirport" in d and "status" in d):
                continue
            st = d.get("status") or {}
            sched = d.get("schedule") or {}
            dep_t = (d.get("departureAirport") or {}).get("times") or {}
            arr_t = (d.get("arrivalAirport") or {}).get("times") or {}
            status_code = st.get("statusCode") if isinstance(st, dict) else None
            status_text = st.get("status") if isinstance(st, dict) else str(st)
            status = STATUS_CODES.get(status_code or "", None) or norm_status(status_text)
            desc = (st.get("statusDescription") or "") if isinstance(st, dict) else ""
            if status == "scheduled" and "delay" in desc.lower():
                status = "delayed"
            dep_est_title = ((dep_t.get("estimatedActual") or {}).get("title") or sched.get("estimatedActualDepartureTitle") or "")
            arr_est_title = ((arr_t.get("estimatedActual") or {}).get("title") or sched.get("estimatedActualArrivalTitle") or "")
            out = {
                "status": status,
                "status_text": " ".join(x for x in [status_text, desc] if x).strip(),
                "sched_dep": _time_from(dep_t.get("scheduled")) or _time_from(sched.get("scheduledDeparture")),
                "sched_arr": _time_from(arr_t.get("scheduled")) or _time_from(sched.get("scheduledArrival")),
                "dep_time": _time_from(dep_t.get("estimatedActual")) or _time_from(sched.get("estimatedActualDeparture")),
                "arr_time": _time_from(arr_t.get("estimatedActual")) or _time_from(sched.get("estimatedActualArrival")),
                "dep_is_actual": "actual" in dep_est_title.lower(),
                "arr_is_actual": "actual" in arr_est_title.lower(),
                "parser": "flightstats-json",
            }
            # A diversion (including a return to the origin) shows up as divertedAirport and/or
            # status.diverted; the status code alone may still read "L" (landed).
            div = (d.get("divertedAirport") or {}).get("iata") or (d.get("positional") or {}).get("divertedAirportCode")
            if div or (isinstance(st, dict) and st.get("diverted")):
                out["status"] = "diverted"
                out["diverted_to"] = div
            if out["sched_dep"] or out["sched_arr"]:
                return out
    return None


def strip_html(page: str) -> str:
    page = re.sub(r"<(script|style|noscript)[^>]*>.*?</\1>", " ", page, flags=re.S | re.I)
    page = re.sub(r"<[^>]+>", " ", page)
    return re.sub(r"\s+", " ", htmllib.unescape(page)).strip()


TIME_RE = r"(\d{1,2}:\d{2}(?:\s*[AP]M)?|--:--|--)"
TZ_RE = r"(?:P[DS]T)?"


def parse_flightstats_text(page: str) -> dict | None:
    """Fallback: parse the rendered text, e.g.
    '... on behalf of Air Canada Arrived On time ... Scheduled 09:05 PDT Actual 08:59 PDT ...'"""
    text = strip_html(page)
    if re.search(r"DATE IS OUT OF RANGE|Flight Status Not Available", text, re.I):
        return {"status": "unavailable", "parser": "flightstats-text"}
    pairs = re.findall(
        rf"Scheduled\s*{TIME_RE}\s*{TZ_RE}\s*(Actual|Estimated)\s*{TIME_RE}\s*{TZ_RE}", text, re.I
    )
    status_text = ""
    m = re.search(r"on behalf of [A-Za-z .]+?\s+((?:Arrived|Landed|Departed|En[ -]Route|Scheduled|Cancell?ed|Diverted|Delayed|Unknown)[A-Za-z0-9 ]{0,40}?)(?=\s+(?:[A-Z]{3}\b|Departure|Flight|Tracking|Positional|Arrival|\d))", text)
    if m:
        status_text = m.group(1).strip()
    else:
        m = re.search(r"\b(Cancell?ed|Diverted|Arrived|Landed|En[ -]Route|Departed|Delayed|Scheduled)\b(\s+(?:On time|Delayed by \w+|Early by \w+))?", text)
        status_text = (m.group(0) if m else "").strip()
    if not pairs and not status_text:
        return None
    status = norm_status(status_text)
    if status == "scheduled" and "delay" in status_text.lower():
        status = "delayed"
    out = {"status": status, "status_text": status_text, "parser": "flightstats-text",
           "sched_dep": None, "sched_arr": None, "dep_time": None, "arr_time": None,
           "dep_is_actual": False, "arr_is_actual": False}
    if len(pairs) >= 1:
        out["sched_dep"], kind, t = to_24h(pairs[0][0]), pairs[0][1], pairs[0][2]
        out["dep_time"], out["dep_is_actual"] = to_24h(t), kind.lower() == "actual"
    if len(pairs) >= 2:
        out["sched_arr"], kind, t = to_24h(pairs[1][0]), pairs[1][1], pairs[1][2]
        out["arr_time"], out["arr_is_actual"] = to_24h(t), kind.lower() == "actual"
    return out


def fetch_flightstats(f: dict, day: dt.date, debug: bool) -> dict | None:
    url = (f"https://www.flightstats.com/v2/flight-tracker/{f['carrier']}/{f['number']}"
           f"?year={day.year}&month={day.month}&date={day.day}")
    try:
        page = get(url)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  ! flightstats {f['flight']} {day}: {e}", file=sys.stderr)
        return None
    if debug:
        DEBUG.mkdir(exist_ok=True)
        (DEBUG / f"flightstats-{f['flight']}-{day}.html").write_text(page)
    res = parse_flightstats_json(page) or parse_flightstats_text(page)
    if res:
        res["source_url"] = url
    return res


# ------------------------------------------------------------- aerodatabox (opt)

ADB_STATUS = {
    "arrived": "arrived", "canceled": "cancelled", "canceleduncertain": "cancelled", "diverted": "diverted",
    "enroute": "en_route", "departed": "en_route", "approaching": "en_route", "delayed": "delayed",
    "expected": "scheduled", "checkin": "scheduled", "boarding": "scheduled", "gateclosed": "scheduled",
}


def fetch_aerodatabox(f: dict, day: dt.date) -> dict | None:
    key = os.environ.get("AERODATABOX_KEY")
    if not key:
        return None
    url = f"https://aerodatabox.p.rapidapi.com/flights/number/{f['flight']}/{day.isoformat()}?withAircraftImage=false&withLocation=false"
    try:
        rows = json.loads(get(url, {"X-RapidAPI-Key": key, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com"}))
    except Exception as e:  # noqa: BLE001
        print(f"  ! aerodatabox {f['flight']} {day}: {e}", file=sys.stderr)
        return None
    if not rows:
        return None
    r = rows[0]
    dep, arr = r.get("departure", {}), r.get("arrival", {})

    def hm(node):
        loc = (node or {}).get("local") or ""
        m = re.search(r"(\d{2}):(\d{2})", loc)
        return f"{m.group(1)}:{m.group(2)}" if m else None

    dep_act = hm(dep.get("runwayTime")) or hm(dep.get("actualTime"))
    arr_act = hm(arr.get("runwayTime")) or hm(arr.get("actualTime"))
    raw = str(r.get("status", ""))
    return {
        "status": ADB_STATUS.get(raw.lower(), "unknown"), "status_text": raw, "parser": "aerodatabox",
        "sched_dep": hm(dep.get("scheduledTime")), "sched_arr": hm(arr.get("scheduledTime")),
        "dep_time": dep_act or hm(dep.get("revisedTime")), "arr_time": arr_act or hm(arr.get("revisedTime")),
        "dep_is_actual": bool(dep_act), "arr_is_actual": bool(arr_act),
        "diverted_to": (arr.get("airport") or {}).get("iata") if raw.lower() == "diverted" else None,
    }


# ------------------------------------------------------------------- weather

def fetch_metars(hours: int = 72) -> list[str]:
    try:
        txt = get(f"https://aviationweather.gov/api/data/metar?ids={STATION}&format=raw&hours={hours}")
        return [ln.strip() for ln in txt.splitlines() if ln.strip()]
    except Exception as e:  # noqa: BLE001
        print(f"  ! metar: {e}", file=sys.stderr)
        return []


def fetch_taf() -> str | None:
    try:
        txt = get(f"https://aviationweather.gov/api/data/taf?ids={STATION}&format=raw")
        return re.sub(r"\s+", " ", txt).strip() or None
    except Exception as e:  # noqa: BLE001
        print(f"  ! taf: {e}", file=sys.stderr)
        return None


def metar_time(raw: str, ref: dt.datetime) -> dt.datetime | None:
    m = re.search(r"\b(\d{2})(\d{2})(\d{2})Z\b", raw)
    if not m:
        return None
    d, h, mi = map(int, m.groups())
    cand = ref.astimezone(dt.timezone.utc).replace(day=1, hour=h, minute=mi, second=0, microsecond=0)
    # find the month that makes this the most recent past date
    for back in (0, 1):
        y, mo = cand.year, cand.month - back
        if mo == 0:
            y, mo = y - 1, 12
        try:
            t = cand.replace(year=y, month=mo, day=d)
        except ValueError:
            continue
        if t <= ref.astimezone(dt.timezone.utc) + dt.timedelta(hours=1):
            return t
    return None


def nearest_metar(metars: list[str], when: dt.datetime, max_gap_h: float = 2.0) -> str | None:
    best, gap = None, None
    for raw in metars:
        t = metar_time(raw, when + dt.timedelta(days=1))
        if not t:
            continue
        g = abs((t - when).total_seconds()) / 3600
        if g <= max_gap_h and (gap is None or g < gap):
            best, gap = raw, g
    return best


# ------------------------------------------------------------------- outcomes

def outcome(rec: dict) -> str | None:
    s = rec.get("status")
    if s == "cancelled":
        return "cancelled"
    if s == "diverted":
        return "diverted"
    if s == "arrived":
        d = rec.get("arr_delay_min")
        return "delayed" if d is not None and d > 15 else "on_time"
    return None


def minutes_between(a: str | None, b: str | None) -> int | None:
    if not a or not b:
        return None
    ah, am = map(int, a.split(":"))
    bh, bm = map(int, b.split(":"))
    diff = (bh * 60 + bm) - (ah * 60 + am)
    if diff < -12 * 60:  # crossed midnight
        diff += 24 * 60
    return diff


def enrich(f: dict, day: dt.date, res: dict) -> dict:
    rec = {"date": day.isoformat(), **{k: f[k] for k in ("flight", "from", "to", "kind")}, **res}
    rec["dep_delay_min"] = minutes_between(rec.get("sched_dep"), rec.get("dep_time"))
    rec["arr_delay_min"] = minutes_between(rec.get("sched_arr"), rec.get("arr_time"))
    rec["outcome"] = outcome(rec)
    return rec


# ---------------------------------------------------------------------- main

def load(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--days-back", type=int, default=3, help="FlightStats serves +/-3 days")
    args = ap.parse_args()

    now = dt.datetime.now(TZ)
    today = now.date()
    DATA.mkdir(exist_ok=True)
    history = load(DATA / "history.json", {"flights": []})
    hist_idx = {(r["date"], r["flight"]): r for r in history["flights"]}

    metars = fetch_metars(72)
    taf = fetch_taf()

    flights_today, flights_tomorrow, failures = [], [], []
    for offset in range(-args.days_back, 2):
        day = today + dt.timedelta(days=offset)
        for f in FLIGHTS:
            key = (day.isoformat(), f["flight"])
            # skip past days already finalised in history
            if offset < 0 and key in hist_idx and hist_idx[key].get("outcome"):
                continue
            res = fetch_flightstats(f, day, args.debug)
            if not res or res.get("status") in (None, "unknown"):
                res = fetch_aerodatabox(f, day) or res
            if not res or res.get("status") == "unavailable":
                if offset >= 0:
                    failures.append(f"{f['flight']} {day}")
                continue
            rec = enrich(f, day, res)
            print(f"  {day} {f['flight']}: {rec['status']} ({rec.get('parser')}) dep {rec.get('sched_dep')}->{rec.get('dep_time')} arr {rec.get('sched_arr')}->{rec.get('arr_time')}")
            if offset == 0:
                flights_today.append(rec)
            elif offset == 1:
                flights_tomorrow.append(rec)
            if offset <= 0 and rec["outcome"]:
                # weather at scheduled YCG time (arrival for inbound, departure for outbound)
                ycg_time = rec["sched_arr"] if f["kind"] == "arrival" else rec["sched_dep"]
                if ycg_time:
                    h, m = map(int, ycg_time.split(":"))
                    when = dt.datetime.combine(day, dt.time(h, m), TZ).astimezone(dt.timezone.utc)
                    rec["metar"] = nearest_metar(metars, when) or (hist_idx.get(key) or {}).get("metar")
                rec["recorded_at"] = now.isoformat(timespec="seconds")
                hist_idx[key] = {k: v for k, v in rec.items() if k not in ("source_url",)}

    latest = {
        "generated_at": now.isoformat(timespec="seconds"),
        "date": today.isoformat(),
        "station": STATION,
        "flights": flights_today,
        "tomorrow": flights_tomorrow,
        "metars": metars[:30],
        "taf": taf,
        "failures": failures,
    }
    (DATA / "latest.json").write_text(json.dumps(latest, indent=1) + "\n")

    history["flights"] = sorted(hist_idx.values(), key=lambda r: (r["date"], r["flight"]))
    new_hist = json.dumps(history, indent=1) + "\n"
    old_hist = (DATA / "history.json").read_text() if (DATA / "history.json").exists() else ""
    if new_hist != old_hist:
        (DATA / "history.json").write_text(new_hist)
        print("  history.json updated")
    if failures:
        print(f"  ! no status for: {', '.join(failures)}", file=sys.stderr)
    # Non-zero exit only if we got nothing at all for today (surfaces scraper breakage in Actions)
    return 1 if len(failures) == len(FLIGHTS) * 2 else 0


if __name__ == "__main__":
    sys.exit(main())
