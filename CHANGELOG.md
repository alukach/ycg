# Changelog

Notable changes to the dashboard, fetcher and outlook model. Newest first.

## 2026-10-03

### Added
- First version: today's and tomorrow's AC8376/AC8377 status, METAR/TAF, hourly forecast, cancellation outlook and outcome history, deployed to GitHub Pages every 15 minutes.
- "Coming days" shows tomorrow and the day after, within Open-Meteo's 3-day forecast.
- Every external data source is linked from the page and the README.

### Changed
- Weather-model evidence is weighted down with lead time (≈0.5 at 24 h, 0.25 at 48 h), so tomorrow and the day after lean on the seasonal base and say so.
- The latest METAR now counts up to 6 h before the flight, with weight fading after 75 min. Previously an 08:00 low-cloud report was ignored for a 10:14 arrival.

### Fixed
- FlightStats status code `A` means *Active* (airborne), not arrived. In-flight runs no longer finalise a flight early. Code `NO` (not operational) now counts as cancelled.
- Outlook no longer counts bad weather twice. The seasonal base already includes bad-weather days, so a clear METAR, TAF or model forecast now pulls the risk *below* the base (e.g. clear December ≈ 11%, not 25%).
- Low ceiling, poor visibility and fog are scored as one risk (the worst of the three) instead of being added together, which pushed foggy days to ~99%.
