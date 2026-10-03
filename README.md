# YCG Flight Watch

A static dashboard for two West Kootenay airports: Castlegar (YCG; Air Canada AC8376/8377 to Vancouver) and Trail (YZZ; Pacific Coastal 8P451/452). It shows live status and delays, METAR/TAF, an hourly forecast, a cancellation outlook, and a running history of outcomes.

## How it works

```
GitHub Actions (every 15 min in the flight window, every 3 h otherwise)
  scripts/fetch.py      FlightStats status (±3 days) · aviationweather.gov METAR/TAF
                        NAV CANADA NOTAMs · adsb.lol aircraft position · IEM METAR archive
                        AeroDataBox (optional fallback)
     └─► data/<id>/latest.json              deployed only
         data/<id>/history.json             committed: outcomes + METAR at flight time
         data/<id>/events.json → feed.xml   committed: status changes → Atom feed, ntfy.sh (optional)
  scripts/predict.mjs
     └─► data/<id>/predictions.json         committed: outlook at 48/24/12/6/3/1 h before each flight
  └─► GitHub Pages deploy

Browser: index.html + assets/app.js + assets/wx.js
  ├─ data/*.json
  └─ Open-Meteo hourly forecast + ECMWF ensemble (fetched live)
```

- **Flight status** is scraped from FlightStats' public tracker pages. The parser tries the embedded Next.js state first and falls back to the rendered text. Each run uploads the raw HTML as a `debug-html` artifact (kept 3 days) so a markup change can be fixed quickly.
- **History**: past days are finalised once FlightStats reports Arrived, Cancelled or Diverted (including returns to YVR). A flight still unresolved when it drops out of FlightStats' 3-day window, or a day the job missed, is recorded as `unknown`, so gaps stay visible. Each record keeps the METAR nearest the scheduled YCG time, taken from the IEM archive if it was missed live. A year of records is well under 1 MB.
- **Prediction log**: `scripts/predict.mjs` runs the same outlook code under Node and records one prediction per flight in each lead window (48/24/12/6/3/1 h). The page scores these against outcomes (Brier score per lead time), and that's the data for fitting the weights.
- **Airports** are defined in `assets/airports.json`. Trail has no published METAR/TAF, so it borrows Castlegar's (25 km away) at 0.6 weight, and Open-Meteo for Trail itself can outweigh them. Adding an airport is one config entry, provided FlightStats tracks its flights.
- **Outlook**: `assets/wx.js` is a transparent heuristic with no dependencies. It starts from a base rate (trailing 30 days blended with `month_base` from `assets/airports.json`) and adds logit terms for weather from the METAR, the TAF or Open-Meteo (the ECMWF ensemble 12 h+ ahead). Model evidence shrinks with lead time. AC8377 follows AC8376, because it is the same aircraft. Live status overrides everything. Fit the weights against `data/<id>/predictions.json` and `history.json` once a winter of data exists.

## Setup

1. Push to `main` on GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write.**
4. Run the workflow once from the Actions tab (`workflow_dispatch`).
5. Optional: set an `NTFY_TOPIC` secret to push status changes (delays, cancellations, diversions) to [ntfy.sh](https://ntfy.sh). Anyone can subscribe to the same changes through the Atom feed at `data/<id>/feed.xml`.
6. Optional: add a RapidAPI key for [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) as the `AERODATABOX_KEY` secret. It is used only when FlightStats returns nothing usable.

GitHub disables scheduled workflows after 60 days without repository activity; the daily history commits keep it alive.

## Local development

```sh
python -m unittest scripts/test_fetch.py   # parser tests (offline)
node --test scripts/test_wx.mjs            # outlook tests (offline)
python scripts/fetch.py --debug             # refresh data/ (needs network)
python -m http.server                       # http://localhost:8000
```

## Caveats

- FlightStats has no public API contract; if its markup changes, the scraper will need adjusting (the run fails, which emails the repo owner, and the page shows a banner).
- The outlook is not an airline forecast. Always confirm with Air Canada.
- Not affiliated with Air Canada, Jazz, or the airport.

## Data sources

| Data | Source | Used for |
|---|---|---|
| Flight status (±3 days) | [FlightStats flight tracker](https://www.flightstats.com/v2/flight-tracker/arrivals/YCG) | Today/tomorrow status, history outcomes |
| METAR / TAF | [aviationweather.gov Data API](https://aviationweather.gov/data/api/) ([CYCG METAR](https://aviationweather.gov/api/data/metar?ids=CYCG&format=raw&hours=24), [TAF](https://aviationweather.gov/api/data/taf?ids=CYCG&format=raw)) | Observations, TAF, weather attached to history |
| Hourly forecast | [Open-Meteo](https://open-meteo.com/en/docs) | Chart, model-based risk terms |
| Ensemble forecast | [Open-Meteo Ensemble API](https://open-meteo.com/en/docs/ensemble-api) (ECMWF IFS, 51 runs) | Risk and range 12 h+ ahead |
| Historical METAR archive | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/request/download.phtml?network=CA_BC_ASOS) | Linked from history rows; candidate for weather backfill |
| 84% success rate, shuttle | [Nelson Star, 2024](https://www.nelsonstar.com/local-news/weather-cancellation-shuttle-to-continue-at-castlegar-airport-7619017) | Reference line, context |
| Shuttle details | [WKRA flight disruption shuttle FAQ](https://www.wkrairport.ca/passengers/faqs-flight-disruption-shuttle/) | "If the flight is cancelled" panel |
| Airport / approach | [Wikipedia](https://en.wikipedia.org/wiki/West_Kootenay_Regional_Airport) | Context |
| NOTAMs | [NAV CANADA CFPS](https://plan.navcanada.ca/wxrecall/) (undocumented JSON endpoint) | Runway/approach notices, alerts |
| Inbound aircraft position | [adsb.lol API](https://api.adsb.lol/docs) (ODbL) | Where today's aircraft is now |
| Optional fallback | [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) | Status if FlightStats fails |

Seasonal base rates (`month_base` in `assets/airports.json`) are hand-set estimates, not published figures.
