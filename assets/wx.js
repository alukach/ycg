// METAR / TAF parsing and the cancellation heuristic. No dependencies.

export const TZ = "America/Vancouver";

/** "2026-10-03" + "10:14" in Vancouver time -> Date */
export function zoned(iso, hm) {
  const guess = new Date(`${iso}T${hm}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

/** Open-Meteo hourly key ("2026-10-03T10:00", local time) for the hour nearest `when`. */
export function hourKey(when) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(new Date(when.getTime() + 30 * 60e3)).replace(" ", "T") + ":00";
}

// ---------------------------------------------------------------- helpers

const COVER = { FEW: 1, SCT: 2, BKN: 3, OVC: 4, VV: 4 };

function parseVis(tokens) {
  // Returns statute miles or null. Handles "P6SM", "15SM", "1/2SM", "1 1/2SM", "M1/4SM".
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m = t.match(/^([PM])?(\d+)?(?:\/(\d+))?SM$/);
    if (!m) continue;
    let v;
    if (m[3]) v = Number(m[2]) / Number(m[3]);
    else v = Number(m[2]);
    if (m[3] && i > 0 && /^\d+$/.test(tokens[i - 1])) v += Number(tokens[i - 1]);
    if (m[1] === "P") v = Math.max(v, 6.01);
    return v;
  }
  return null;
}

function parseClouds(tokens) {
  const layers = [];
  for (const t of tokens) {
    const m = t.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    if (m) layers.push({ cover: m[1], base: Number(m[2]) * 100, type: m[3] || null });
    if (t === "SKC" || t === "CLR" || t === "NSC") layers.push({ cover: t, base: null });
  }
  return layers;
}

export function ceilingOf(layers) {
  const c = layers.filter((l) => l.base != null && COVER[l.cover] >= 3).map((l) => l.base);
  return c.length ? Math.min(...c) : null;
}

const WX_RE = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)$/;

function parseWx(tokens) {
  return tokens.filter((t) => WX_RE.test(t) && t !== "NSW");
}

function parseWind(tokens) {
  for (const t of tokens) {
    const m = t.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/);
    if (m) return { dir: m[1] === "VRB" ? null : Number(m[1]), speed: Number(m[2]), gust: m[3] ? Number(m[3]) : null };
  }
  return null;
}

/** Resolve a ddhhmm (UTC) reference to a Date near `ref`. */
function dayHourToDate(d, h, mi, ref) {
  const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1, 0, 0));
  let best = null;
  for (const mo of [-1, 0, 1]) {
    const t = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + mo, d, h, mi));
    if (t.getUTCDate() !== d) continue;
    if (!best || Math.abs(t - ref) < Math.abs(best - ref)) best = t;
  }
  return best;
}

// ------------------------------------------------------------------ METAR

export function parseMetar(raw, ref = new Date()) {
  if (!raw) return null;
  const body = raw.split(" RMK ")[0];
  const tokens = body.trim().split(/\s+/);
  const tm = body.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const time = tm ? dayHourToDate(+tm[1], +tm[2], +tm[3], ref) : null;
  const temp = body.match(/\s(M?\d{2})\/(M?\d{2})?\s/);
  const toC = (s) => (s == null ? null : s.startsWith("M") ? -Number(s.slice(1)) : Number(s));
  const layers = parseClouds(tokens);
  return {
    raw,
    time,
    wind: parseWind(tokens),
    vis: parseVis(tokens),
    wx: parseWx(tokens.slice(3)),
    layers,
    ceiling: ceilingOf(layers),
    temp: temp ? toC(temp[1]) : null,
    dew: temp ? toC(temp[2]) : null,
  };
}

// -------------------------------------------------------------------- TAF

export function parseTaf(raw, ref = new Date()) {
  if (!raw) return null;
  const text = raw.split(" RMK ")[0].replace(/\s+/g, " ").trim();
  const hdr = text.match(/\b(\d{2})(\d{2})(\d{2})Z\s+(\d{2})(\d{2})\/(\d{2})(\d{2})/);
  if (!hdr) return null;
  const issued = dayHourToDate(+hdr[1], +hdr[2], +hdr[3], ref);
  const vFrom = dayHourToDate(+hdr[4], +hdr[5], 0, issued);
  const vTo = dayHourToDate(+hdr[6], +hdr[7] % 24, 0, issued);
  if (+hdr[7] === 24) vTo.setUTCDate(vTo.getUTCDate() + 1);
  const rest = text.slice(hdr.index + hdr[0].length);
  // split into change groups
  const parts = rest.split(/\s(?=FM\d{6}|TEMPO\s|BECMG\s|PROB\d{2}\s)/);
  const groups = [];
  const range = (s) => {
    const m = s.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
    if (!m) return [null, null];
    const a = dayHourToDate(+m[1], +m[2], 0, issued);
    const b = dayHourToDate(+m[3], +m[4] % 24, 0, issued);
    if (+m[4] === 24) b.setUTCDate(b.getUTCDate() + 1);
    return [a, b];
  };
  for (const p of parts) {
    const s = p.trim();
    const tokens = s.split(" ");
    let kind = "BASE", from = vFrom, to = vTo, prob = null;
    let m;
    if ((m = s.match(/^FM(\d{2})(\d{2})(\d{2})/))) {
      kind = "FM";
      from = dayHourToDate(+m[1], +m[2], +m[3], issued);
    } else if (s.startsWith("TEMPO")) {
      kind = "TEMPO";
      [from, to] = range(s);
    } else if (s.startsWith("BECMG")) {
      kind = "BECMG";
      [from, to] = range(s);
    } else if ((m = s.match(/^PROB(\d{2})/))) {
      kind = "PROB";
      prob = Number(m[1]);
      [from, to] = range(s);
    }
    const layers = parseClouds(tokens);
    groups.push({ kind, prob, from, to, text: s, wind: parseWind(tokens), vis: parseVis(tokens), wx: parseWx(tokens), layers, ceiling: ceilingOf(layers), hasClouds: layers.length > 0 });
  }
  return { raw, issued, from: vFrom, to: vTo, groups };
}

/** Conditions forecast at time t: {prevailing, temporary[]} or null if t is outside the TAF. */
export function tafAt(taf, t) {
  if (!taf || t < taf.from || t > taf.to) return null;
  let prev = null;
  for (const g of taf.groups) {
    if (g.kind === "BASE") prev = { ...g };
    else if ((g.kind === "FM" && g.from <= t) || (g.kind === "BECMG" && g.to && g.to <= t)) {
      // FM replaces everything; BECMG overrides only what it states
      prev = g.kind === "FM" ? { ...g } : {
        ...prev,
        wind: g.wind || prev.wind,
        vis: g.vis ?? prev.vis,
        wx: g.wx.length ? g.wx : prev.wx,
        layers: g.hasClouds ? g.layers : prev.layers,
        ceiling: g.hasClouds ? g.ceiling : prev.ceiling,
      };
    }
  }
  // TEMPO/PROB groups, plus any BECMG still in its transition window (either state may apply)
  const temporary = taf.groups.filter((g) => ["TEMPO", "PROB", "BECMG"].includes(g.kind) && g.from <= t && g.to >= t);
  return { prevailing: prev, temporary };
}

// ---------------------------------------------------------- the heuristic
//
// P(cancel or divert) = sigmoid( logit(seasonal base) + Σ weather terms ).
// Base rates and weights are hand-set from published YCG figures (84% landing success,
// Dec 2023–Sep 2024; winter fog/low cloud dominate) and are meant to be re-tuned
// against data/history.json as it accumulates.

/**
 * Base rate from the trailing window of observed arrivals, shrunk toward the seasonal prior
 * (beta-binomial: (failures + K*prior) / (n + K)). With few recorded flights it stays near the
 * prior; after ~30 days the recent regime (e.g. a valley-cloud inversion spell) dominates.
 */
export const PRIOR_WEIGHT = 15;
export function rollingBase(history, beforeIso, when, days = 30) {
  const month = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "numeric" }).format(when)) - 1;
  const prior = MONTH_BASE[month];
  const start = new Date(beforeIso + "T12:00:00Z");
  start.setUTCDate(start.getUTCDate() - days);
  const from = start.toISOString().slice(0, 10);
  const recs = history.filter((r) => r.flight === "AC8376" && r.outcome && r.outcome !== "unknown" && r.date >= from && r.date < beforeIso);
  const n = recs.length;
  const fails = recs.filter((r) => r.outcome === "cancelled" || r.outcome === "diverted").length;
  const p = (fails + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
  return {
    p, n, fails, prior,
    label: n ? `Last ${days} days: ${fails}/${n} arrivals failed` : `Seasonal base (no recent history)`,
    detail: `${fails}/${n} observed, blended with ${Math.round(prior * 100)}% seasonal prior`,
  };
}

export const MONTH_BASE = [0.22, 0.18, 0.12, 0.08, 0.05, 0.04, 0.05, 0.06, 0.06, 0.1, 0.2, 0.25];
export const CLEAR_DAY = -1.0;
/**
 * Weight on the weather model's evidence by lead time: ≈0.7 at 12 h, 0.5 at 24 h, 0.25 at 48 h.
 * Deterministic low-cloud/fog skill in a narrow valley decays to roughly climatology by ~2 days.
 * ponytail: τ=36 h is a guess; fit it per lead bucket from data/predictions.json once outcomes accrue.
 */
export const modelWeight = (leadH) => Math.exp(-leadH / 36);
/**
 * Weight on the latest METAR as a persistence forecast, by hours from the observation to the
 * flight: full within 75 min, then fading (≈0.6 at 2 h, 0.15 at 5 h), none beyond 6 h or if stale.
 */
export function metarWeight(gapH) {
  if (gapH == null || gapH < -1.25 || gapH > 6) return 0;
  return gapH <= 1.25 ? 1 : Math.exp(-(gapH - 1.25) / 2);
}
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function ceilingTerm(c) {
  if (c == null) return 0;
  if (c <= 1000) return 3.2;
  if (c <= 1500) return 2.4;
  if (c <= 2500) return 1.2;
  if (c <= 4000) return 0.5;
  return 0;
}
function visTerm(v) {
  if (v == null) return 0;
  if (v < 1) return 2.6;
  if (v < 3) return 1.6;
  if (v < 5) return 0.8;
  return 0;
}
function wxTerm(wx) {
  let s = 0;
  const notes = [];
  const has = (re) => wx.some((w) => re.test(w));
  if (has(/FZ(RA|DZ)/)) { s += 2.0; notes.push("freezing precip"); }
  if (has(/^\+.*SN|^\+SHSN/)) { s += 1.6; notes.push("heavy snow"); }
  else if (has(/SN/)) { s += 0.9; notes.push("snow"); }
  if (has(/FU/)) { s += 0.6; notes.push("smoke"); }
  if (has(/TS/)) { s += 0.8; notes.push("thunderstorm"); }
  return { s, notes };
}
function fogTerm(wx) {
  if (wx.some((w) => /FG/.test(w) && !/^(MI|BC|PR)FG/.test(w))) return ["fog", 1.0];
  if (wx.some((w) => /BR/.test(w))) return ["mist", 0.3];
  return ["", 0];
}
function windTerm(w) {
  const g = w ? Math.max(w.gust || 0, w.speed || 0) : 0;
  if (g >= 35) return 1.4;
  if (g >= 25) return 0.6;
  return 0;
}

function conditionScore(c) {
  // c: {ceiling, vis, wx[], wind}
  const parts = [];
  const add = (label, v) => v > 0 && parts.push({ label, v });
  // Low ceiling, low visibility and fog are one phenomenon seen three ways: count the worst, not the sum.
  const obsc = [[`ceiling ${c.ceiling?.toLocaleString()} ft`, ceilingTerm(c.ceiling)], [`visibility ${fmtVis(c.vis)}`, visTerm(c.vis)], fogTerm(c.wx || [])].filter((o) => o[1] > 0);
  if (obsc.length) add(obsc.map((o) => o[0]).join(", "), Math.max(...obsc.map((o) => o[1])));
  const w = wxTerm(c.wx || []);
  add(w.notes.join(", "), w.s);
  const wt = windTerm(c.wind);
  add(`wind ${c.wind?.speed}${c.wind?.gust ? "G" + c.wind.gust : ""} kt`, wt);
  return { total: parts.reduce((a, b) => a + b.v, 0), parts };
}

export function fmtVis(v) {
  if (v == null) return "—";
  if (v > 6) return "6+ SM";
  if (v < 1) return `${Math.round(v * 100) / 100} SM`;
  return `${Math.round(v * 10) / 10} SM`;
}

/** Hourly Open-Meteo row -> condition object. */
export function omConditions(h) {
  if (!h) return null;
  const wx = [];
  if (h.weather_code === 45 || h.weather_code === 48) wx.push("FG");
  if (h.snowfall > 1) wx.push("+SN");
  else if (h.snowfall > 0) wx.push("SN");
  if ([56, 57, 66, 67].includes(h.weather_code)) wx.push("FZRA");
  // Model low-cloud % has no base height. Treat a near-overcast low deck as a ~2000 ft ceiling proxy.
  const ceiling = h.cloud_cover_low >= 90 ? 2000 : h.cloud_cover_low >= 70 ? 3500 : null;
  return {
    ceiling,
    vis: h.visibility != null ? h.visibility / 1609.34 : null,
    wx,
    wind: { speed: Math.round(h.wind_speed_10m ?? 0), gust: Math.round(h.wind_gusts_10m ?? 0) },
  };
}

/**
 * ctx: { when: Date (scheduled YCG time), metar, taf, omHour, status, inbound }
 * Returns { p, label, basis, factors: [{label, v}] }
 */
export function predict(ctx) {
  const month = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "numeric" }).format(ctx.when)) - 1;
  const seasonal = MONTH_BASE[month];
  const base = ctx.base?.p ?? seasonal;
  const factors = [{ label: ctx.base?.label ?? `Seasonal base (${new Intl.DateTimeFormat("en-CA", { month: "long", timeZone: TZ }).format(ctx.when)})`, v: logit(base), isBase: true, p: base, detail: ctx.base?.detail }];

  // --- live status overrides
  const st = ctx.status;
  if (st === "cancelled" || st === "diverted") return { p: 1, basis: `Flight ${st}`, factors, final: true };
  if (st === "arrived") return { p: 0, basis: "Flight completed", factors, final: true };
  if (ctx.inbound && ["cancelled", "diverted"].includes(ctx.inbound.status))
    return { p: 0.97, basis: `Inbound ${ctx.inbound.flight} ${ctx.inbound.status}: no aircraft at YCG`, factors };

  // --- weather at the scheduled YCG time
  const now = ctx.now ?? new Date();
  const taf = tafAt(ctx.taf, ctx.when);
  const sources = [];
  let main = { total: 0, parts: [] };
  const mtw = metarWeight(ctx.metar?.time ? (ctx.when - ctx.metar.time) / 3600e3 : null);
  if (mtw > 0) {
    const m = conditionScore(ctx.metar);
    const tag = mtw < 1 ? ` (now, ×${mtw.toFixed(2)})` : "";
    main = { total: m.total * mtw, parts: m.parts.map((p) => ({ ...p, v: p.v * mtw, label: p.label + tag })) };
    sources.push("METAR");
  }
  if (taf?.prevailing) {
    const s = conditionScore(taf.prevailing);
    if (s.total >= main.total) main = s;
    sources.push("TAF");
    // extra risk from temporary groups, measured against whichever source won above
    const baseTotal = main.total;
    for (const g of taf.temporary) {
      const ts = conditionScore({ ...taf.prevailing, ...pick(g) });
      const weight = g.prob ? g.prob / 100 : g.kind === "BECMG" ? 1 : 0.5;
      const extra = (ts.total - baseTotal) * weight;
      if (extra > 0.05) main.parts.push({ label: `${g.kind === "PROB" ? "PROB" + g.prob : g.kind}: ${ts.parts.map((p) => p.label).join(", ")}`, v: extra });
    }
  }
  const om = omConditions(ctx.omHour);
  const leadH = Math.max(0, (ctx.when - now) / 3600e3);
  const mw = modelWeight(leadH);
  const modelOnly = om && !sources.length;
  const ens = modelOnly && leadH >= 12 && ctx.ensHour?.length ? ctx.ensHour.map((m) => conditionScore(omConditions(m)).total) : null;
  if (ens) {
    // Ensemble: average the evidence over all runs; their spread gives the range shown on the card.
    const mean = ens.reduce((a, b) => a + b, 0) / ens.length;
    const k = ens.filter((t) => t > 0).length;
    main = { total: mean * mw, parts: mean > 0 ? [{ label: `risk weather in ${k} of ${ens.length} forecast runs (model)`, v: mean * mw }] : [] };
    sources.push("ensemble");
  } else if (om) {
    const s = conditionScore(om);
    if (modelOnly) {
      main = { total: s.total * mw, parts: s.parts.map((p) => ({ ...p, v: p.v * mw, label: p.label + " (model)" })) };
    } else {
      // precip type and gusts from the model can still add risk the TAF omits
      for (const p of s.parts) if (/snow|freezing|wind/.test(p.label) && !main.parts.some((q) => q.label.startsWith(p.label.split(" ")[0]))) main.parts.push({ ...p, v: p.v * 0.5 * mw, label: p.label + " (model)" });
    }
    sources.push("model");
  }
  factors.push(...main.parts);
  // The base rate is an average over all days, bad weather included, so weather terms measured
  // from zero would count bad days twice. Once a weather source covers the flight, start from a
  // clear day instead. ponytail: hand-set (clear December ≈ 11% vs 25% average); fit from history.
  const evidenceW = Math.max(mtw, taf?.prevailing ? 1 : 0, om ? mw : 0);
  if (sources.length) factors.push({ label: "Clear-day adjustment", v: CLEAR_DAY * evidenceW, isBase: true });

  let x = factors.reduce((a, f) => a + f.v, 0);
  let p = sigmoid(x);
  let range = null;
  if (ens) {
    const xs = ens.map((t) => x + (t * mw - main.total)).sort((a, b) => a - b);
    range = [sigmoid(xs[Math.floor(xs.length * 0.1)]), sigmoid(xs[Math.ceil(xs.length * 0.9) - 1])];
  }
  let basis = `Weather (${sources.join(" + ") || "season only"})`;
  if (modelOnly && mw < 0.9) basis = `Mostly seasonal: weather model ${Math.round(leadH)} h ahead, weighted ×${mw.toFixed(2)}`;

  if (ctx.kind === "departure") {
    if (ctx.inbound?.status === "arrived") {
      // aircraft is on the ground; departures are rarely weather-cancelled
      p = Math.min(p, sigmoid(logit(0.02) + 0.3 * main.parts.reduce((a, f) => a + f.v, 0)));
      basis = "Inbound arrived; departure risk only";
    } else if (ctx.inboundP != null) {
      p = ctx.inboundP + (1 - ctx.inboundP) * 0.02;
      range = ctx.inboundRange?.map((q) => q + (1 - q) * 0.02) ?? null;
      basis = `Tied to inbound ${ctx.inbound?.flight ?? "flight"} (same aircraft)`;
    }
  }
  return { p, range, basis, factors, sources, when: ctx.when, now, leadH, modelWeight: modelOnly ? mw : 1 };
}

function pick(g) {
  const o = {};
  if (g.vis != null) o.vis = g.vis;
  if (g.hasClouds) o.ceiling = g.ceiling;
  if (g.wx?.length) o.wx = g.wx;
  if (g.wind) o.wind = g.wind;
  return o;
}

export function riskLabel(p) {
  if (p >= 0.6) return { key: "critical", text: "High" };
  if (p >= 0.3) return { key: "serious", text: "Elevated" };
  if (p >= 0.12) return { key: "warning", text: "Moderate" };
  return { key: "good", text: "Low" };
}

/**
 * Predictions for one day's [arrival, departure]. The departure is the same aircraft, so its
 * risk follows the arrival. forecast: Open-Meteo hourly rows; history: data/history.json flights.
 */
export function predictDay({ dateIso, flights, metar, taf, forecast, ensemble, history, now = new Date() }) {
  const [arr, dep] = flights;
  const base = rollingBase(history || [], dateIso, zoned(dateIso, arr.sched_arr));
  const ctxFor = (f) => {
    const when = zoned(dateIso, f.kind === "arrival" ? f.sched_arr : f.sched_dep);
    const key = hourKey(when);
    return { when, now, metar, taf, kind: f.kind, status: f.status, base, omHour: forecast?.find((h) => h.time === key) || null, ensHour: ensemble?.[key] };
  };
  const pa = predict(ctxFor(arr));
  const pd = predict({ ...ctxFor(dep), inbound: arr, inboundP: pa.p, inboundRange: pa.range });
  return [pa, pd];
}

export const ENSEMBLE_MODEL = "ecmwf_ifs025"; // the only Open-Meteo ensemble with low cloud at YCG (checked 2026-10-03)
export const ENSEMBLE_VARS = ["cloud_cover_low", "weather_code", "snowfall", "wind_speed_10m", "wind_gusts_10m"];

/** Open-Meteo ensemble response -> { "2026-10-04T10:00": [member rows...] } */
export function ensembleByHour(j) {
  const h = j?.hourly;
  if (!h) return null;
  const members = Object.keys(h).filter((k) => k.startsWith("cloud_cover_low")).map((k) => k.slice("cloud_cover_low".length));
  const out = {};
  h.time.forEach((t, i) => {
    const rows = members.map((suf) => Object.fromEntries(ENSEMBLE_VARS.map((v) => [v, h[v + suf]?.[i] ?? null]))).filter((r) => r.cloud_cover_low != null);
    if (rows.length) out[t] = rows;
  });
  return out;
}
