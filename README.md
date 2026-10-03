# YCG Flight Watch

A static dashboard for Castlegar / West Kootenay Regional Airport (YCG): today's Air Canada flights (AC8376 YVR→YCG, AC8377 YCG→YVR), live status and delays, METAR/TAF, an hourly forecast, a cancellation outlook, and a running history of outcomes.

## How it works

```
GitHub Actions (cron, every 15 min in the flight window)
  scripts/fetch.py ──► FlightStats flight tracker (±3 days)   ─┐
                   ├─► aviationweather.gov METAR (72 h) + TAF  ├─► data/latest.json  (deployed only)
                   ├─► adsb.lol (inbound aircraft position)    │
                   └─► AeroDataBox (optional fallback)         ─┘   data/history.json (committed when it changes)
  └─► GitHub Pages deploy (actions/deploy-pages)

Browser: index.html + assets/app.js
  ├─ data/latest.json, data/history.json
  └─ Open-Meteo hourly + ensemble forecasts (fetched live, CORS-enabled)
```

- **Flight status** is scraped from FlightStats' public tracker pages. The parser tries the embedded Next.js state first and falls back to the rendered text. Each run uploads the raw HTML as a `debug-html` artifact (kept 3 days) so a markup change can be fixed quickly.
- **History**: past days are finalised once FlightStats reports Arrived / Cancelled / Diverted. Each record keeps the METAR closest to the scheduled YCG time, so outcomes can be compared against the observed ceiling and visibility. Records are ~0.5 KB, so a year is well under 1 MB and stays in git.
- **Outlook**: `assets/wx.js` is a transparent heuristic: a seasonal base rate (`MONTH_BASE`) plus logit terms for ceiling, visibility, fog/snow/freezing precipitation and gusts, taken from the METAR (if within ~75 min), the TAF (incl. TEMPO/PROB groups) or Open-Meteo. AC8377 follows AC8376 because it is the same aircraft. Live status overrides everything. Re-tune the weights against `data/history.json` once a winter of data exists.

## Setup

1. Push to `main` on GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write.**
4. Run the workflow once from the Actions tab (`workflow_dispatch`).
5. Optional: add a RapidAPI key for [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) as the `AERODATABOX_KEY` secret. It is used only when FlightStats returns nothing usable.

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
| 84% success rate, shuttle | [Boundary Creek Times, 2024](https://www.boundarycreektimes.com/local-news/weather-cancellation-shuttle-to-continue-at-castlegar-airport-7619017) | Reference line, context |
| Airport / approach | [Wikipedia](https://en.wikipedia.org/wiki/West_Kootenay_Regional_Airport) | Context |
| Inbound aircraft position | [adsb.lol API](https://api.adsb.lol/docs) (ODbL) | Where today's aircraft is now |
| Optional fallback | [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) | Status if FlightStats fails |

Seasonal base rates (`MONTH_BASE` in `assets/wx.js`) are hand-set estimates, not published figures.
