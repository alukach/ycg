// Log the outlook at fixed lead times so its skill can be measured (see renderSkill in app.js).
// Runs in the Action after fetch.py:  node scripts/predict.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { localDate, parseMetar, parseTaf, predictDay, flightsFor, forecastUrl, ensembleUrl, hourlyRows, ensembleByHour } from "../assets/wx.js";

// A prediction is logged once per lead window (hours before the scheduled YCG time): the first run
// whose lead falls in (lower, upper] records it. Windows are missed, not back-filled, if no run lands in them.
export const LEADS = [48, 24, 12, 6, 3, 1];

export function leadBucket(leadH) {
  const i = LEADS.findIndex((b, k) => leadH <= b && leadH > (LEADS[k + 1] ?? 0));
  return i < 0 ? null : LEADS[i];
}

const read = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const getJSON = async (url) => { try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; } };

async function main() {
  const now = new Date();
  const L = read("data/latest.json", null);
  const history = read("data/history.json", { flights: [] }).flights;
  const log = read("data/predictions.json", { predictions: [] });
  const [fc, ens] = await Promise.all([getJSON(forecastUrl()), getJSON(ensembleUrl())]);
  const forecast = fc ? hourlyRows(fc) : null, ensemble = ens ? ensembleByHour(ens) : null;
  const taf = parseTaf(L?.taf, now);
  const metar = L?.metars?.length ? parseMetar(L.metars[0], now) : null;
  const today = localDate(now);
  const have = new Set(log.predictions.map((r) => `${r.date}|${r.flight}|${r.lead}`));
  let added = 0;
  for (const n of [0, 1, 2]) {
    const date = localDate(new Date(+now + n * 864e5));
    const recs = date === L?.date ? L.flights : (L?.tomorrow || []).filter((r) => r.date === date);
    const flights = flightsFor(date, recs);
    const preds = predictDay({ dateIso: date, flights, metar: date === today ? metar : null, taf, forecast, ensemble, history, now });
    flights.forEach((f, i) => {
      const p = preds[i], lead = leadBucket(p.leadH);
      if (!lead || p.final || have.has(`${date}|${f.flight}|${lead}`)) return;
      log.predictions.push({ date, flight: f.flight, lead, lead_h: +p.leadH.toFixed(2), p: +p.p.toFixed(4),
        range: p.range?.map((q) => +q.toFixed(4)) ?? null, base: +p.factors[0].p.toFixed(4), sources: p.sources, at: now.toISOString() });
      added++;
    });
  }
  if (added) writeFileSync("data/predictions.json", JSON.stringify(log, null, 1) + "\n");
  console.log(`  ${added} prediction(s) logged`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
