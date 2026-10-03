# Changelog

Notable changes to the dashboard, fetcher and outlook model. Newest first.

## 2026-10-03

### Added
- First version: today's and tomorrow's AC8376/AC8377 status, METAR/TAF, hourly forecast, cancellation outlook and outcome history, deployed to GitHub Pages every 15 minutes.
- "Coming days" shows tomorrow and the day after, within Open-Meteo's 3-day forecast.
- Every external data source is linked from the page and the README.
- For flights 12 h+ ahead, the outlook averages the 51-member ECMWF ensemble (Open-Meteo) instead of a single model run, and cards show the range across runs.
- History keeps gaps visible: a flight with no final status by the time FlightStats stops serving it (3 days), or a day the job never ran, is recorded as *Unknown* and excluded from rates.
- History records without weather get the METAR nearest the flight time from the Iowa Environmental Mesonet archive.

### Changed
- Weather-model evidence is weighted down with lead time (≈0.5 at 24 h, 0.25 at 48 h), so tomorrow and the day after lean on the seasonal base and say so.
- The latest METAR now counts up to 6 h before the flight, with weight fading after 75 min. Previously an 08:00 low-cloud report was ignored for a 10:14 arrival.

### Fixed
- FlightStats status code `A` means *Active* (airborne), not arrived. In-flight runs no longer finalise a flight early. Code `NO` (not operational) now counts as cancelled.
- Outlook no longer counts bad weather twice. The seasonal base already includes bad-weather days, so a clear METAR, TAF or model forecast now pulls the risk *below* the base (e.g. clear December ≈ 11%, not 25%).
- Low ceiling, poor visibility and fog are scored as one risk (the worst of the three) instead of being added together, which pushed foggy days to ~99%.
- TAF handling: a BECMG change still in progress counts its worse state; TEMPO/PROB risk is measured against the METAR when the METAR is the worse source; a `BCFG` group no longer hides reported `FG`.
- A broken scraper now fails the GitHub Actions run (after deploying), so GitHub emails the owner instead of logging a warning nobody sees.
- Diversions, including an AC8376 that turns back to Vancouver, are recorded from FlightStats' diverted-airport fields even when the status code says *landed*. The card and history show where the flight went.

### Removed
- The unexplained ×0.5 risk discount once the inbound aircraft is airborne. Turning back is how YCG arrivals usually fail.
