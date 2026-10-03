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
- Today's arrival card shows where the inbound aircraft is right now (tail number from FlightStats, live position from adsb.lol), e.g. *on the ground at YVR* or *airborne, 48 nm from YCG*.
- CYCG NOTAMs from NAV CANADA, with runway, approach, lighting and navaid notices and contaminated-runway reports flagged. Flagged temporary NOTAMs in force today appear as an alert at the top of the page.
- Status-change alerts: delays, cancellations, diversions and arrivals are logged to `data/events.json` and published as an Atom feed (`data/feed.xml`, linked in the header). Set `NTFY_TOPIC` to also push them to ntfy.sh.
- The outlook is logged at fixed lead times (48, 24, 12, 6, 3 and 1 h before each flight) to `data/predictions.json`. History shows its Brier score against the base rate alone, per lead time, so you can see whether the weather terms help.
- Warnings when flight data can't be loaded or is stale (over 45 min old during the flight window, 4 h otherwise), and a loading placeholder in place of an empty page.
- "If the flight is cancelled" panel: how Air Canada's free shuttle via Kelowna works in each direction, typical timings, eligibility, and links to flight status, bookings and the airport FAQ. It opens automatically on disrupted or Elevated-risk days.
- Keyboard and screen-reader access: history cells can be reached with Tab and arrow keys (tooltips on focus), the forecast and 30-day charts have text equivalents, and the day/range tabs support arrow keys.
- Links to a specific day (`#date=YYYY-MM-DD`, also used by feed entries) jump to and highlight that day's cards or history rows. Day headings are shareable links, and the page has link-preview (OpenGraph) tags.
- "Arrivals that land, by month" table for planning trips weeks ahead: the seasonal estimate next to recorded outcomes.
- The hourly forecast chart has a third tab for the day after tomorrow, labelled with its weekday.
- Trail Regional Airport (YZZ): Pacific Coastal 8P451/452, tracked the same way as Castlegar. Trail has no published METAR/TAF, so its outlook uses Castlegar's at reduced weight (labelled *Castlegar, 25 km*) alongside the weather model for Trail itself.
- Airport switcher in the header (Castlegar YCG · Trail YZZ). The choice is in the URL (`?a=yzz`, shareable) and remembered per browser. Titles, links, feed and airport-specific sections (the Air Canada shuttle panel and the 84% reference line are Castlegar-only) follow the selected airport.

### Changed
- Weather-model evidence is weighted down with lead time (≈0.5 at 24 h, 0.25 at 48 h), so tomorrow and the day after lean on the seasonal base and say so.
- The latest METAR now counts up to 6 h before the flight, with weight fading after 75 min. Previously an 08:00 low-cloud report was ignored for a 10:14 arrival.
- The page refreshes only while visible (and immediately when you return to it), and auto-refresh no longer scrolls the history strip back to the end.
- Cards lead with a plain answer: a one-line summary per flight at the top, risk in words with advice (e.g. *No action needed*), and the estimate rounded to the nearest 5% ("~10%"). Forecast shorthand is spelled out ("30% chance of…", "at times…"), and "Coming days" sits above the weather charts.
- Data files moved to `data/ycg/` (`history.json`, `latest.json`, `events.json`, `predictions.json`, `feed.xml`), ready for more airports. Airport details (flights, coordinates, weather station, seasonal base) now come from one `assets/airports.json`.

### Fixed
- FlightStats status code `A` means *Active* (airborne), not arrived. In-flight runs no longer finalise a flight early. Code `NO` (not operational) now counts as cancelled.
- Outlook no longer counts bad weather twice. The seasonal base already includes bad-weather days, so a clear METAR, TAF or model forecast now pulls the risk *below* the base (e.g. clear December ≈ 11%, not 25%).
- Low ceiling, poor visibility and fog are scored as one risk (the worst of the three) instead of being added together, which pushed foggy days to ~99%.
- TAF handling: a BECMG change still in progress counts its worse state; TEMPO/PROB risk is measured against the METAR when the METAR is the worse source; a `BCFG` group no longer hides reported `FG`.
- A broken scraper now fails the GitHub Actions run (after deploying), so GitHub emails the owner instead of logging a warning nobody sees.
- Diversions, including an AC8376 that turns back to Vancouver, are recorded from FlightStats' diverted-airport fields even when the status code says *landed*. The card and history show where the flight went.
- Times are correct after BC moves to permanent UTC−7 on 1 Nov 2026. The page no longer relies on the browser's (often stale) time-zone data, and CI fails if the runner's tz database predates the change.
- Dead link to the 2024 shuttle article (Boundary Creek Times returns 404) now points to the same story on the Nelson Star.
- Cancelled, diverted and completed flights show a status icon instead of a misleading "100%"/"0%" risk gauge.
- Contrast: muted text darkened to pass WCAG AA (5:1), the amber risk ring drawn darker in light mode, dashed "no record" cells visible in dark mode, and the theme button enlarged to a 44 px tap target.

### Removed
- The unexplained ×0.5 risk discount once the inbound aircraft is airborne. Turning back is how YCG arrivals usually fail.
