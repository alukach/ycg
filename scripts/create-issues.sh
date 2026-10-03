#!/usr/bin/env bash
# One-off: file known future work as GitHub issues on alukach/ycg.
# Requires an authenticated GitHub CLI (`gh auth login`). Run from anywhere:
#   bash scripts/create-issues.sh
set -euo pipefail
REPO="${REPO:-alukach/ycg}"

issue() { # title, labels, body (stdin)
  gh issue create --repo "$REPO" --title "$1" --label "$2" --body-file -
}

gh label create backfill    --repo "$REPO" --color 5319e7 --description "Historical data backfill" 2>/dev/null || true
gh label create prediction  --repo "$REPO" --color 1d76db --description "Cancellation outlook model" 2>/dev/null || true
gh label create reliability --repo "$REPO" --color d93f0b --description "Scraper / pipeline robustness" 2>/dev/null || true

issue "Backfill historical flight outcomes (2–3 winters)" "backfill" <<'EOF'
FlightStats only serves ±3 days, so `data/history.json` starts 2026-09-30. The rolling 30-day base rate and the weather weights need multiple winters of outcomes to be meaningful.

**Candidate sources**
- [OpenSky Network](https://openskynetwork.github.io/opensky-api/rest.html#arrivals-by-airport) `GET /flights/arrival?airport=CYCG&begin=&end=` (max 7-day window per call, free). No cancellation flag: a scheduled day with no YCG arrival = cancelled or diverted. ADS-B coverage in the Kootenays is unverified.
- [FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi/) history endpoints: paid per query, has explicit cancelled/diverted status. Likely the cleanest single source.
- [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) flight-by-number for past dates: depth unverified.

**Also needed:** the historical schedule, since flight numbers changed (AC8466 until Feb 2026, then AC8376/8377) and service days vary by season ([flightmapper](https://info.flightmapper.net/route/Air_Canada_AC_YVR_YCG)). Without it, "no arrival" can't be distinguished from "not scheduled".

**Done when:** a one-off `scripts/backfill.py` writes records in the existing `history.json` schema with `parser` set to the source, and the 30-day chart covers at least two winters.
EOF

issue "Backfill historical METARs from Iowa Environmental Mesonet" "backfill" <<'EOF'
Attach observed weather to backfilled history records so outcomes can be analysed by ceiling/visibility.

- Source: [IEM ASOS/METAR download](https://mesonet.agron.iastate.edu/request/download.phtml?network=CA_BC_ASOS), station `CYCG`, e.g. `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=CYCG&data=metar&year1=2023&month1=11&day1=1&year2=2024&month2=3&day2=1&tz=Etc%2FUTC&format=onlycomma`
- Reuse `nearest_metar()` in `scripts/fetch.py` to pick the observation closest to the scheduled YCG time (arrival for AC8376, departure for AC8377).
- Consider storing the full 06:00–12:00 local METAR sequence per day, not just the nearest one: trend (lifting vs. lowering ceiling) probably matters.
EOF

issue "Calibrate the cancellation heuristic against recorded history" "prediction" <<'EOF'
`MONTH_BASE` and the logit weights in `assets/wx.js` are hand-set estimates. Once the outcome and METAR backfills land:

- Fit a logistic regression on ceiling, visibility, wx (FG/BR/SN/FZ), gusts, month, and trailing-30-day failure rate. Keep the model transparent (coefficients shipped as JSON and shown on the page).
- Report Brier score and a reliability diagram on the page so the outlook's accuracy is visible.
- Resolve the known double count: the trailing-30-day base and today's weather terms both rise during inversion spells. Either fit them jointly or use the 30-day rate only as a prior on the intercept.
- Re-tune `PRIOR_WEIGHT` (currently 15 pseudo-flights) from the data.
EOF

issue "Record the outlook at fixed times to measure forecast skill" "prediction" <<'EOF'
History stores outcomes and the observed METAR, but not what the page *predicted*. Without that we can't evaluate the outlook.

- Run `assets/wx.js` under Node in the Action (it has no DOM dependencies) at fixed lead times: evening before (~19:00), 06:00, and 08:30 local.
- Store `{lead, p, factors, sources}` per flight per day in `data/predictions.json` (or on the history record).
- Feeds the Brier score / reliability work in the calibration issue.
EOF

issue "Extend the outlook to 5–7 days with lead-time decay" "prediction" <<'EOF'
Today the page shows today + tomorrow. [Open-Meteo](https://open-meteo.com/en/docs) forecasts up to 16 days, but low cloud, valley fog and inversions at YCG have little skill beyond ~2–3 days.

- Add a 7-day strip of daily risk.
- Shrink the weather terms toward the base rate as lead time grows, e.g. `weather_logit × max(0, 1 − (lead_days − 1) / 4)`, so day 5+ is effectively the base rate.
- Show a confidence label per day (high / medium / low skill).
- Candidate extra variables for multi-day: `cloud_cover_low` persistence, freezing level, 850 hPa temperature inversion strength.
EOF

issue "Derive the flight schedule from data instead of hardcoding it" "reliability" <<'EOF'
`SCHEDULE` in `assets/app.js` and `FLIGHTS` in `scripts/fetch.py` hardcode AC8376/AC8377 and their times. These change seasonally (e.g. times change 2026-10-25 per [flightmapper](https://info.flightmapper.net/route/Air_Canada_AC_YVR_YCG)), and flight numbers have changed before (AC8466 → AC8376).

- Discover YCG flights daily from the [FlightStats YCG arrivals](https://www.flightstats.com/v2/flight-tracker/arrivals/YCG) / [departures](https://www.flightstats.com/v2/flight-tracker/departures/YCG) boards, and write them into `latest.json`.
- Frontend uses `latest.json` schedule; hardcoded values become a fallback only.
- Handle days with no scheduled service (record as "not scheduled", not as a failure).
EOF

issue "Alert when the FlightStats scraper breaks" "reliability" <<'EOF'
FlightStats has no API contract. The parser (embedded Next.js JSON first, rendered-text fallback) is working as of 2026-10-03, but a markup change would silently degrade to "schedule only".

- On consecutive parse failures for today's flights, have the Action open (or update) a GitHub issue with the raw HTML attached from the `debug-html` artifact.
- Add a fixture test using a real saved FlightStats page (from the `debug-html` artifact) so parser changes are tested against real markup, not only synthetic fixtures.
- Exercise the optional [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) fallback (`AERODATABOX_KEY`) end to end; it has only been written, not run.
EOF

issue "Capture diversion destination and shuttle days" "reliability" <<'EOF'
When YCG weather fails, flights may divert (typically Kelowna or Cranbrook) and Air Canada runs a bus shuttle via Kelowna ([Boundary Creek Times](https://www.boundarycreektimes.com/local-news/weather-cancellation-shuttle-to-continue-at-castlegar-airport-7619017)).

- Parse the diverted-to airport from FlightStats (the AeroDataBox path already sets `diverted_to`).
- Show it on the flight card and in history.
- Distinguish cancelled-at-origin (never left YVR) from airborne diversion: different signal for the model (forecast vs. conditions on arrival).
EOF

echo "Done: https://github.com/$REPO/issues"
