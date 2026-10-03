import { TZ, parseMetar, parseTaf, predictDay, riskLabel, fmtVis, ensembleByHour, ENSEMBLE_MODEL, ENSEMBLE_VARS } from "./wx.js";

const LAT = 49.2961, LON = -117.6325;
const SCHEDULE = [
  { flight: "AC8376", from: "YVR", to: "YCG", kind: "arrival", sched_dep: "09:05", sched_arr: "10:14" },
  { flight: "AC8377", from: "YCG", to: "YVR", kind: "departure", sched_dep: "10:50", sched_arr: "12:05" },
];
const OUTCOMES = {
  on_time: { label: "On time", cls: "on_time", status: "good" },
  delayed: { label: "Delayed >15 min", cls: "delayed", status: "warning" },
  diverted: { label: "Diverted", cls: "diverted", status: "serious" },
  cancelled: { label: "Cancelled", cls: "cancelled", status: "critical" },
};
const STATUS_PILL = {
  scheduled: ["Scheduled", ""], delayed: ["Delayed", "warning"], en_route: ["En route", "good"],
  arrived: ["Arrived", "good"], cancelled: ["Cancelled", "critical"], diverted: ["Diverted", "serious"],
  unknown: ["Status unknown", ""], schedule: ["Schedule only", ""],
};

const $ = (s) => document.querySelector(s);
const REPO = "https://github.com/alukach/ycg";
const SRC = {
  metar: "https://aviationweather.gov/api/data/metar?ids=CYCG&format=raw&hours=24",
  taf: "https://aviationweather.gov/api/data/taf?ids=CYCG&format=raw",
  awcPage: "https://aviationweather.gov/data/metar/?id=CYCG&hours=24&decoded=yes&taf=yes",
  shuttle: "https://www.boundarycreektimes.com/local-news/weather-cancellation-shuttle-to-continue-at-castlegar-airport-7619017",
  historyCommits: `${REPO}/commits/main/data/history.json`,
};
const fsUrl = (flight, iso) => `https://www.flightstats.com/v2/flight-tracker/AC/${flight.replace(/^AC/, "")}?year=${+iso.slice(0, 4)}&month=${+iso.slice(5, 7)}&date=${+iso.slice(8, 10)}`;
const iemUrl = (iso) => { const [y, m, d] = iso.split("-").map(Number); const n = new Date(Date.UTC(y, m - 1, d + 1)); return `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=CYCG&data=metar&year1=${y}&month1=${m}&day1=${d}&year2=${n.getUTCFullYear()}&month2=${n.getUTCMonth() + 1}&day2=${n.getUTCDate()}&tz=Etc%2FUTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4`; };
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (p) => `${Math.round(p * 100)}%`;

// ------------------------------------------------------------ time helpers

function localDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmtTime = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
const fmtDay = (iso, opts = { weekday: "long", month: "long", day: "numeric" }) => new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z"));
function ago(d) {
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function diffMin(a, b) {
  if (!a || !b) return null;
  const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

// ------------------------------------------------------------------ data

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
async function loadForecast() {
  const p = new URLSearchParams({
    latitude: LAT, longitude: LON, timezone: TZ, forecast_days: "3", wind_speed_unit: "kn",
    hourly: "temperature_2m,precipitation,rain,snowfall,cloud_cover_low,visibility,wind_speed_10m,wind_gusts_10m,weather_code",
  });
  state.forecastUrl = `https://api.open-meteo.com/v1/forecast?${p}`;
  const j = await getJSON(state.forecastUrl);
  const h = j.hourly;
  return h.time.map((t, i) => Object.fromEntries([["time", t], ...Object.keys(h).filter((k) => k !== "time").map((k) => [k, h[k][i]])]));
}

async function loadEnsemble() {
  const p = new URLSearchParams({ latitude: LAT, longitude: LON, timezone: TZ, forecast_days: "3", wind_speed_unit: "kn", models: ENSEMBLE_MODEL, hourly: ENSEMBLE_VARS.join(",") });
  return ensembleByHour(await getJSON(`https://ensemble-api.open-meteo.com/v1/ensemble?${p}`));
}

const state = { latest: null, history: { flights: [] }, forecast: null, fcDay: 0, range: 30 };

// --------------------------------------------------------------- render

function flightsFor(dateIso, recs) {
  return SCHEDULE.map((s) => {
    const r = (recs || []).find((x) => x.flight === s.flight && (!x.date || x.date === dateIso));
    return r ? { ...s, ...r, sched_dep: r.sched_dep || s.sched_dep, sched_arr: r.sched_arr || s.sched_arr } : { ...s, date: dateIso, status: "schedule" };
  });
}

function predictionsFor(dateIso, flights, metar, taf) {
  return predictDay({ dateIso, flights, metar, taf, forecast: state.forecast, ensemble: state.ensemble, history: state.history.flights });
}

function gauge(p, statusKey) {
  const r = 30, c = 2 * Math.PI * r, v = Math.max(0.02, Math.min(1, p));
  return `<svg class="gauge" viewBox="0 0 76 76" role="img" aria-label="${pct(p)} chance of cancellation or diversion">
    <circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
    <circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--${statusKey})" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${c * v} ${c}" transform="rotate(-90 38 38)"/>
    <text x="38" y="44" text-anchor="middle">${pct(p)}</text></svg>`;
}

function timeCell(label, sched, t, isActual, cancelled) {
  if (cancelled) return `<div class="time">${label} <s>${sched}</s></div>`;
  const d = diffMin(sched, t);
  if (!t || t === sched || d === 0) return `<div class="time">${label} <b>${sched}</b>${isActual ? " ✓" : ""}</div>`;
  const cls = d > 0 ? "late" : "early";
  return `<div class="time">${label} <s>${sched}</s> <b>${t}</b> <span class="${cls}">${d > 0 ? "+" : ""}${d}m</span>${isActual ? "" : " est."}</div>`;
}

function flightCard(f, pred, compact = false) {
  const [pillText, pillCls] = STATUS_PILL[f.status] || STATUS_PILL.unknown;
  const cancelled = f.status === "cancelled";
  const rl = riskLabel(pred.p);
  const maxV = 3.5;
  const factors = pred.final ? "" : pred.factors.filter((x) => !x.isBase).sort((a, b) => b.v - a.v).slice(0, 4)
    .map((x) => `<li><span>${esc(x.label)}</span><span class="bar"><i style="width:${Math.min(100, (x.v / maxV) * 100)}%"></i></span></li>`).join("");
  const baseNote = pred.final ? "" : `<div class="risk-basis" title="${esc(pred.factors[0].detail || "")}">Base ${pct(pred.factors[0].p)} (${esc(pred.factors[0].label)})${factors ? "; adding:" : "; no weather risk factors"}</div>`;
  return `<article class="card flight">
    <div class="f-head">
      <div><div class="f-num">${ext(f.source_url || fsUrl(f.flight, f.date), f.flight)}</div><div class="f-dir">${f.kind === "arrival" ? "Arrival from Vancouver" : "Departure to Vancouver"} · Air Canada Express (Jazz)</div></div>
      <span class="pill ${pillCls}"><span class="dot"></span>${esc(pillText)}</span>
    </div>
    <div class="route">
      <div class="end"><div class="iata">${f.from}</div>${timeCell("Dep", f.sched_dep, f.dep_time, f.dep_is_actual, cancelled)}</div>
      <div class="line" aria-hidden="true"></div>
      <div class="end"><div class="iata">${f.to}</div>${timeCell("Arr", f.sched_arr, f.arr_time, f.arr_is_actual, cancelled)}</div>
    </div>
    ${f.status_text && !compact ? `<div class="f-dir">Airline status: ${esc(f.status_text)} · ${ext(f.source_url || fsUrl(f.flight, f.date), "FlightStats ↗")}</div>` : ""}
    <div class="risk">
      ${gauge(pred.p, rl.key)}
      <div>
        <div class="risk-title">${pred.final ? esc(pred.basis) : `${rl.text} risk of cancellation or diversion`}</div>
        ${pred.final ? "" : `<div class="risk-basis">${esc(pred.basis)}</div>`}
        ${pred.range && pct(pred.range[0]) !== pct(pred.range[1]) ? `<div class="risk-basis">Range across forecast runs: ${pct(pred.range[0])}–${pct(pred.range[1])}</div>` : ""}
        ${compact ? "" : baseNote}
        ${compact || !factors ? "" : `<ul class="factors">${factors}</ul>`}
      </div>
    </div>
  </article>`;
}

function renderFlights() {
  const today = localDate();
  const L = state.latest;
  const recs = L && L.date === today ? L.flights : (L?.tomorrow || []).filter((r) => r.date === today);
  const flights = flightsFor(today, recs);
  const metar = L?.metars?.length ? parseMetar(L.metars[0]) : null;
  const taf = parseTaf(L?.taf);
  const preds = predictionsFor(today, flights, metar, taf);
  $("#flights").innerHTML = flights.map((f, i) => flightCard(f, preds[i])).join("");

  // ponytail: horizon is bounded by Open-Meteo forecast_days (3); beyond that it's base rate only
  $("#tomorrow").innerHTML = [1, 2].map((n) => {
    const d = addDays(today, n);
    const fs = flightsFor(d, (L?.tomorrow || []).filter((r) => r.date === d));
    const ps = predictionsFor(d, fs, null, taf);
    return `<h3>${n === 1 ? "Tomorrow" : fmtDay(d, { weekday: "long" })} · ${fmtDay(d, { month: "short", day: "numeric" })}</h3>
      <div class="flights small">${fs.map((f, i) => flightCard(f, ps[i], true)).join("")}</div>`;
  }).join("");
}

function renderObs() {
  const L = state.latest;
  const m = L?.metars?.length ? parseMetar(L.metars[0]) : null;
  if (!m) { $("#obs").innerHTML = `<div class="chart-title">Latest observation</div><p class="muted">No METAR available.</p>`; return; }
  const wind = m.wind ? (m.wind.speed === 0 ? "Calm" : `${m.wind.dir ?? "Variable"}${m.wind.dir != null ? "°" : ""} at ${m.wind.speed} kt${m.wind.gust ? `, gusting ${m.wind.gust}` : ""}`) : "—";
  const clouds = m.layers.length ? m.layers.map((l) => (l.base != null ? `${l.cover} ${l.base.toLocaleString()} ft` : l.cover)).join(", ") : "Clear";
  const wxMap = { BR: "mist", FG: "fog", RA: "rain", SN: "snow", DZ: "drizzle", FU: "smoke", HZ: "haze", SH: "showers", TS: "thunder", FZ: "freezing " };
  const wxText = m.wx.map((w) => w.replace(/^[+-]/, (s) => (s === "+" ? "heavy " : "light ")).replace(/FZ|SH|TS|BR|FG|RA|SN|DZ|FU|HZ/g, (k) => wxMap[k] + " ").trim()).join(", ");
  $("#obs").innerHTML = `<div class="chart-title">Latest observation <span class="muted">${ext(SRC.awcPage, "METAR")} ${m.time ? fmtTime(m.time) + " · " + ago(m.time) : ""}</span></div>
    <div class="obs-top"><span class="obs-temp">${m.temp ?? "—"}°C</span><span class="muted">dew point ${m.dew ?? "—"}°</span></div>
    <dl class="kv">
      <dt>Ceiling</dt><dd>${m.ceiling != null ? m.ceiling.toLocaleString() + " ft" : "None (no broken/overcast layer)"}</dd>
      <dt>Visibility</dt><dd>${fmtVis(m.vis)}</dd>
      <dt>Clouds</dt><dd>${esc(clouds)}</dd>
      <dt>Wind</dt><dd>${esc(wind)}</dd>
      ${wxText ? `<dt>Weather</dt><dd>${esc(wxText)}</dd>` : ""}
    </dl>
    ${m.time && Date.now() - m.time > 3 * 3600e3 ? `<p class="muted" style="font-size:.8rem;margin:10px 0 0">YCG reports only during airport hours; the last observation may be from the previous evening.</p>` : ""}`;
  $("#raw-wx").textContent = [...(L.metars || []).slice(0, 6), "", L.taf || "No TAF in effect (YCG TAFs are issued during operating hours)."].join("\n");
  $("#raw-src").innerHTML = `Source: ${ext(SRC.metar, "METAR API")} · ${ext(SRC.taf, "TAF API")} · ${ext(SRC.awcPage, "aviationweather.gov decoded view")} · fetched ${L.generated_at ? ago(new Date(L.generated_at)) : "—"}`;
}

// --------------------------------------------------------- forecast chart

function renderForecast() {
  const el = $("#fc-chart");
  if (!state.forecast) { el.innerHTML = `<p class="muted">Forecast unavailable (Open-Meteo did not respond).</p>`; return; }
  const day = addDays(localDate(), state.fcDay);
  const rows = state.forecast.filter((h) => h.time.startsWith(day) && +h.time.slice(11, 13) >= 5 && +h.time.slice(11, 13) <= 20);
  if (!rows.length) { el.innerHTML = `<p class="muted">No forecast hours for ${day}.</p>`; return; }
  $("#fc-src").innerHTML = `· ${ext(state.forecastUrl || "https://open-meteo.com/", "Open-Meteo")} · ${fmtDay(day, { weekday: "short", month: "short", day: "numeric" })}`;

  const W = Math.max(320, Math.min(720, el.clientWidth || 640)), padL = 40, padR = 12, ph = 74, gap = 22, padT = 16;
  const panels = [
    { key: "cloud_cover_low", label: "Low cloud", unit: "%", max: 100, type: "area", ticks: [0, 50, 100] },
    { key: "vis_km", label: "Visibility", unit: " km", max: 25, type: "line", ticks: [0, 10, 20] },
    { key: "precip", label: "Precipitation", unit: " mm", max: Math.max(2, ...rows.map((r) => (r.rain || 0) + (r.snowfall || 0) * 10 / 7)), type: "bars", ticks: null },
    { key: "wind_gusts_10m", label: "Gusts", unit: " kt", max: Math.max(30, ...rows.map((r) => r.wind_gusts_10m || 0)), type: "line", ticks: [0, 15, 30] },
  ];
  rows.forEach((r) => { r.vis_km = r.visibility != null ? Math.min(25, r.visibility / 1000) : null; });
  const H = padT + panels.length * (ph + gap) + 6;
  const n = rows.length, cw = (W - padL - padR) / n;
  const x = (i) => padL + cw * (i + 0.5);
  const hourX = (hm) => { const [h, m] = hm.split(":").map(Number); return padL + cw * (h + m / 60 - 5); };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly forecast for ${day}: low cloud, visibility, precipitation and gusts">`;
  // flight markers
  const marks = [{ t: "10:14", l: "AC8376 arr" }, { t: "10:50", l: "AC8377 dep" }];
  svg += `<rect x="${hourX("09:30")}" y="${padT - 4}" width="${hourX("11:30") - hourX("09:30")}" height="${H - padT}" fill="var(--band)" rx="4"/>`;
  panels.forEach((p, pi) => {
    const y0 = padT + pi * (ph + gap), yb = y0 + ph;
    const y = (v) => yb - (Math.min(v, p.max) / p.max) * ph;
    svg += `<text class="lbl" x="${padL}" y="${y0 - 5}">${p.label}</text>`;
    const ticks = p.ticks || [0, Math.round(p.max * 10) / 20, Math.round(p.max * 10) / 10];
    ticks.forEach((t) => { svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`; });
    if (p.type === "area" || p.type === "line") {
      const pts = rows.map((r, i) => [x(i), r[p.key] == null ? null : y(r[p.key])]).filter((q) => q[1] != null);
      const d = pts.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join("");
      if (p.type === "area") svg += `<path d="${d}L${pts.at(-1)[0]},${yb}L${pts[0][0]},${yb}Z" fill="var(--series-1)" opacity=".18"/>`;
      svg += `<path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
    } else {
      const bw = Math.max(3, cw - 6);
      rows.forEach((r, i) => {
        const rain = r.rain || 0, snow = (r.snowfall || 0) * 10 / 7; // cm snow -> mm water equiv
        if (rain > 0) svg += `<rect x="${x(i) - bw / 2}" y="${y(rain)}" width="${bw}" height="${yb - y(rain)}" rx="2" fill="var(--series-1)"/>`;
        if (snow > 0) svg += `<rect x="${x(i) - bw / 2}" y="${y(rain + snow)}" width="${bw}" height="${Math.max(0, y(rain) - y(rain + snow) - 2)}" rx="2" fill="var(--series-2)"/>`;
      });
      svg += `<g transform="translate(${W - padR - 140},${y0 - 14})"><rect width="9" height="9" rx="2" fill="var(--series-1)"/><text x="13" y="8">Rain</text><rect x="52" width="9" height="9" rx="2" fill="var(--series-2)"/><text x="65" y="8">Snow (water eq.)</text></g>`;
    }
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${yb}" y2="${yb}" stroke="var(--border)"/>`;
  });
  marks.forEach((m, i) => { const mx = hourX(m.t); svg += `<line x1="${mx}" x2="${mx}" y1="${padT - 4}" y2="${H - 6}" stroke="var(--text-2)" stroke-dasharray="3 3"/><text x="${mx + (i ? 4 : -4)}" y="${H}" text-anchor="${i ? "start" : "end"}" class="lbl">${m.l}</text>`; });
  rows.forEach((r, i) => { if (i % (W < 480 ? 5 : 3) === 0) svg += `<text x="${x(i)}" y="${padT + panels.length * (ph + gap) - gap + 14}" text-anchor="middle">${+r.time.slice(11, 13)}:00</text>`; });
  svg += `<line id="xh" x1="0" x2="0" y1="${padT - 4}" y2="${H - 20}" stroke="var(--text)" stroke-width="1" opacity="0"/>`;
  svg += `<rect id="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = svg;

  const s = el.querySelector("svg"), hit = el.querySelector("#hit"), xh = el.querySelector("#xh");
  const move = (ev) => {
    const pt = s.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const lx = pt.matrixTransform(s.getScreenCTM().inverse()).x;
    const i = Math.max(0, Math.min(n - 1, Math.floor((lx - padL) / cw)));
    const r = rows[i];
    xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i)); xh.setAttribute("opacity", ".35");
    showTip(ev, `<b>${r.time.slice(11, 16)}</b>
      <div class="row"><span>Low cloud</span><span>${r.cloud_cover_low ?? "—"}%</span></div>
      <div class="row"><span>Visibility</span><span>${r.visibility != null ? (r.visibility / 1000).toFixed(1) + " km" : "—"}</span></div>
      <div class="row"><span>Rain</span><span>${r.rain ?? 0} mm</span></div>
      <div class="row"><span>Snow</span><span>${r.snowfall ?? 0} cm</span></div>
      <div class="row"><span>Wind / gust</span><span>${Math.round(r.wind_speed_10m)} / ${Math.round(r.wind_gusts_10m)} kt</span></div>
      <div class="row"><span>Temp</span><span>${r.temperature_2m}°C</span></div>`);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { hideTip(); xh.setAttribute("opacity", "0"); });
}

// ---------------------------------------------------------------- history

function renderHistory() {
  const today = localDate();
  const all = state.history.flights.filter((r) => r.outcome);
  const start = state.range ? addDays(today, -state.range) : (all[0]?.date || today);
  const recs = all.filter((r) => r.date >= start);
  const n = recs.length;
  const count = (o) => recs.filter((r) => r.outcome === o).length;
  const tiles = Object.entries(OUTCOMES).map(([k, o]) => {
    const c = count(k);
    return `<div class="stat"><div class="k"><span class="sw ${o.cls}"></span>${o.label}</div><div class="v">${n ? pct(c / n) : "—"}</div><div class="n">${c} of ${n} flights</div></div>`;
  });
  const days = [...new Set(recs.map((r) => r.date))];
  const bothOk = days.filter((d) => recs.filter((r) => r.date === d && ["on_time", "delayed"].includes(r.outcome)).length === 2).length;
  tiles.push(`<div class="stat"><div class="k">Round trips completed</div><div class="v">${days.length ? pct(bothOk / days.length) : "—"}</div><div class="n">${bothOk} of ${days.length} days</div></div>`);
  $("#hist-stats").innerHTML = tiles.join("");

  // strip
  const span = [];
  for (let d = start; d <= today; d = addDays(d, 1)) span.push(d);
  const cell = 16, g = 3, padL = 58, padT = 4;
  const W = padL + span.length * (cell + g), H = padT + 2 * (cell + g) + 18;
  let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Daily outcomes; see table for details">`;
  ["AC8376", "AC8377"].forEach((f, row) => { svg += `<text x="0" y="${padT + row * (cell + g) + 12}">${f}</text>`; });
  span.forEach((d, i) => {
    ["AC8376", "AC8377"].forEach((f, row) => {
      const r = state.history.flights.find((x) => x.date === d && x.flight === f);
      const o = r?.outcome;
      const fill = o ? `var(--${OUTCOMES[o].status})` : "transparent";
      const stroke = o ? "none" : "var(--neutral)";
      svg += `<rect data-d="${d}" data-f="${f}" x="${padL + i * (cell + g)}" y="${padT + row * (cell + g)}" width="${cell}" height="${cell}" rx="3" fill="${fill}" stroke="${stroke}" stroke-dasharray="${o ? "" : "2 2"}"/>`;
    });
    const dd = new Date(d + "T12:00:00Z");
    if (dd.getUTCDate() === 1 || i === 0 || (span.length <= 35 && dd.getUTCDay() === 1)) svg += `<text x="${padL + i * (cell + g)}" y="${H - 2}">${fmtDay(d, { month: "short", day: "numeric" })}</text>`;
  });
  svg += `</svg>`;
  $("#hist-strip").innerHTML = svg;
  $("#hist-strip").scrollLeft = 1e6;
  $("#hist-strip").querySelectorAll("rect[data-d]").forEach((rc) => {
    rc.addEventListener("pointerenter", (ev) => {
      const r = state.history.flights.find((x) => x.date === rc.dataset.d && x.flight === rc.dataset.f);
      showTip(ev, `<b>${rc.dataset.f} · ${fmtDay(rc.dataset.d, { weekday: "short", month: "short", day: "numeric" })}</b>` + (r?.outcome
        ? `<div class="row"><span>Outcome</span><span>${OUTCOMES[r.outcome].label}</span></div><div class="row"><span>Arrival</span><span>${r.arr_time || "—"} (sched ${r.sched_arr})</span></div>${r.metar ? `<div style="margin-top:4px;font-size:.72rem;color:var(--muted)">${esc(r.metar)}</div>` : ""}`
        : `<div class="row"><span>No record</span><span></span></div>`));
    });
    rc.addEventListener("pointerleave", hideTip);
  });
  $("#hist-legend").innerHTML = Object.values(OUTCOMES).map((o) => `<span><span class="sw ${o.cls}"></span>${o.label}</span>`).join("") + `<span><span class="sw none"></span>No record</span>`;

  renderRolling();

  // by ceiling at scheduled time (arrivals only — the weather-sensitive leg)
  const buckets = [["No ceiling", (c) => c == null], ["4,000 ft +", (c) => c >= 4000], ["2,000–3,900 ft", (c) => c >= 2000 && c < 4000], ["Below 2,000 ft", (c) => c != null && c < 2000]];
  const arr = recs.filter((r) => r.flight === "AC8376" && r.metar);
  const rows = buckets.map(([label, test]) => {
    const b = arr.filter((r) => test(parseMetar(r.metar)?.ceiling ?? null));
    const fail = b.filter((r) => ["cancelled", "diverted"].includes(r.outcome)).length;
    return `<tr><td>${label}</td><td>${b.length}</td><td>${fail}</td><td>${b.length ? pct(fail / b.length) : "—"}</td></tr>`;
  });
  $("#by-ceiling").innerHTML = `<div class="chart-title">Arrival outcomes by observed ceiling <span class="muted">METAR nearest scheduled arrival (${ext("https://aviationweather.gov/data/api/", "aviationweather.gov")}) · ${arr.length} flights</span></div>
    <div class="table-wrap"><table><thead><tr><th>Ceiling</th><th>Flights</th><th>Cancelled / diverted</th><th>Rate</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    ${arr.length < 30 ? `<p class="muted" style="font-size:.8rem;margin:8px 0 0">Too few flights recorded to draw conclusions yet; this fills in as the tracker runs and is what the heuristic should be re-tuned against.</p>` : ""}`;

  // full table
  $("#hist-table").innerHTML = `<thead><tr><th>Date</th><th>Flight</th><th>Outcome</th><th>Dep sched / act</th><th>Arr sched / act</th><th>Arr delay</th><th>METAR at YCG</th></tr></thead><tbody>` +
    [...state.history.flights].reverse().map((r) => `<tr><td>${r.date}</td><td>${ext(fsUrl(r.flight, r.date), r.flight)}</td><td>${r.outcome ? `<span class="sw ${r.outcome}"></span> ${OUTCOMES[r.outcome].label}` : esc(r.status)}</td>
      <td>${r.sched_dep} / ${r.dep_time || "—"}</td><td>${r.sched_arr} / ${r.arr_time || "—"}</td><td>${r.arr_delay_min ?? "—"}${r.arr_delay_min != null ? " min" : ""}</td><td class="metar">${esc(r.metar || "")} ${ext(iemUrl(r.date), "archive ↗")}</td></tr>`).join("") + `</tbody>`;
}

function renderRolling() {
  const el = $("#rolling");
  const arr = state.history.flights.filter((r) => r.flight === "AC8376" && r.outcome);
  const today = localDate();
  const first = arr[0]?.date;
  const pts = [];
  if (first) {
    for (let d = first; d <= today; d = addDays(d, 1)) {
      const from = addDays(d, -29);
      const win = arr.filter((r) => r.date >= from && r.date <= d);
      if (win.length >= 5) pts.push({ d, n: win.length, ok: win.filter((r) => !["cancelled", "diverted"].includes(r.outcome)).length });
    }
  }
  const head = `<div class="chart-title">Trailing 30-day arrival completion rate <span class="muted">share of AC8376 arrivals that landed at YCG</span></div>`;
  if (pts.length < 2) {
    el.innerHTML = head + `<p class="muted" style="font-size:.85rem;margin:0">Plotted once at least 5 arrivals fall inside a 30-day window (${arr.length} recorded so far).</p>`;
    return;
  }
  const W = Math.max(320, Math.min(1040, el.clientWidth - 32 || 640)), H = 160, padL = 40, padR = 10, padT = 10, padB = 22;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v) * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trailing 30-day completion rate">`;
  [0, 0.5, 0.84, 1].forEach((t) => { svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" ${t === 0.84 ? 'stroke-dasharray="4 3" stroke="var(--neutral)"' : ""}/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`; });
  svg += `<a href="${SRC.shuttle}" target="_blank" rel="noopener"><text x="${W - padR}" y="${y(0.84) - 4}" text-anchor="end" style="text-decoration:underline">84% (Dec 2023–Sep 2024 avg)</text></a>`;
  svg += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.ok / p.n).toFixed(1)}`).join("")}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
  [0, pts.length - 1].forEach((i) => { svg += `<text x="${x(i)}" y="${H - 4}" text-anchor="${i ? "end" : "start"}">${fmtDay(pts[i].d, { month: "short", day: "numeric" })}</text>`; });
  svg += `<circle id="rdot" r="4" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2" opacity="0"/><rect id="rhit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = head + svg;
  const s = el.querySelector("svg"), dot = el.querySelector("#rdot");
  el.querySelector("#rhit").addEventListener("pointermove", (ev) => {
    const pt = s.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const lx = pt.matrixTransform(s.getScreenCTM().inverse()).x;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((lx - padL) / (W - padL - padR)) * (pts.length - 1))));
    const p = pts[i];
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p.ok / p.n)); dot.setAttribute("opacity", "1");
    showTip(ev, `<b>30 days to ${fmtDay(p.d, { month: "short", day: "numeric" })}</b><div class="row"><span>Completed</span><span>${pct(p.ok / p.n)}</span></div><div class="row"><span>Arrivals</span><span>${p.ok} of ${p.n}</span></div>`);
  });
  el.querySelector("#rhit").addEventListener("pointerleave", () => { hideTip(); dot.setAttribute("opacity", "0"); });
}

// ------------------------------------------------------------------- misc

const tip = $("#tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tip.hidden = true; }

function renderHeader() {
  const today = localDate();
  $("#today-label").textContent = fmtDay(today);
  const L = state.latest;
  if (L?.generated_at) {
    const g = new Date(L.generated_at);
    $("#updated").textContent = `Flight data updated ${ago(g)}`;
    $("#updated").title = g.toString();
  } else $("#updated").textContent = "No flight data yet";
  const alerts = [];
  if (L && L.date !== today) alerts.push(`Flight status data is from ${L.date}; today's status hasn't been fetched yet. Showing the published schedule.`);
  if (L?.failures?.length) alerts.push(`The last update couldn't read status for ${L.failures.join(", ")}.`);
  $("#alerts").innerHTML = alerts.map((a) => `<div class="alert warn">${esc(a)}</div>`).join("");
}

function render() {
  renderHeader();
  renderFlights();
  renderObs();
  renderForecast();
  renderHistory();
}

function wireTabs(sel, attr, fn) {
  document.querySelectorAll(`${sel} button`).forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(`${sel} button`).forEach((x) => x.setAttribute("aria-selected", x === b));
    fn(b.dataset[attr]);
  }));
}
wireTabs(".sec-head .seg:not(#hist-range)", "day", (d) => { state.fcDay = +d; renderForecast(); });
wireTabs("#hist-range", "range", (r) => { state.range = +r; renderHistory(); });

// theme toggle (remembered per browser)
const root = document.documentElement;
try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch {}
$("#theme").addEventListener("click", () => {
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
});

async function load() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const [latest, history, forecast, ensemble] = await Promise.allSettled([getJSON(`data/latest.json${bust}`), getJSON(`data/history.json${bust}`), loadForecast(), loadEnsemble()]);
  if (latest.status === "fulfilled") state.latest = latest.value;
  if (history.status === "fulfilled") state.history = history.value;
  if (forecast.status === "fulfilled") state.forecast = forecast.value;
  if (ensemble.status === "fulfilled") state.ensemble = ensemble.value;
  render();
}
load();
setInterval(load, 5 * 60e3);
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(renderForecast, 150); });
