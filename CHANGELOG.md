# Changelog

Notable changes to the dashboard, fetcher and outlook model. Newest first.

## 2026-10-03

### Added
- First version: today's and tomorrow's AC8376/AC8377 status, METAR/TAF, hourly forecast, cancellation outlook and outcome history, deployed to GitHub Pages every 15 minutes.
- "Coming days" shows tomorrow and the day after, within Open-Meteo's 3-day forecast.
- Every external data source is linked from the page and the README.

### Fixed
- FlightStats status code `A` means *Active* (airborne), not arrived. In-flight runs no longer finalise a flight early. Code `NO` (not operational) now counts as cancelled.
