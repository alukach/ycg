// Outlook tests: node --test scripts/test_wx.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseMetar, parseTaf, tafAt, predictDay, zoned, hourKey, localDate } from "../assets/wx.js";

const SCHED = [
  { flight: "AC8376", kind: "arrival", sched_dep: "09:05", sched_arr: "10:14", status: "schedule" },
  { flight: "AC8377", kind: "departure", sched_dep: "10:50", sched_arr: "12:05", status: "schedule" },
];
const day = (dateIso, opts = {}) => predictDay({ dateIso, flights: SCHED, history: [], ...opts });

test("parseMetar reads ceiling, visibility and weather", () => {
  const m = parseMetar("METAR CYCG 031700Z 00000KT 1/2SM FG VV002 05/05 A3010", new Date("2026-10-03T18:00Z"));
  assert.equal(m.ceiling, 200);
  assert.equal(m.vis, 0.5);
  assert.deepEqual(m.wx, ["FG"]);
});

test("tafAt applies FM groups", () => {
  const taf = parseTaf("TAF CYCG 031440Z 0315/0403 VRB03KT P6SM OVC010 FM031800 VRB03KT P6SM SCT050", new Date("2026-10-03T15:00Z"));
  assert.equal(tafAt(taf, new Date("2026-10-03T16:00Z")).prevailing.ceiling, 1000);
  assert.equal(tafAt(taf, new Date("2026-10-03T19:00Z")).prevailing.ceiling, null);
});

test("departure follows the inbound aircraft", () => {
  const [a, d] = day("2026-12-15");
  assert.ok(d.p >= a.p);
});

test("zoned converts Vancouver local time", () => {
  assert.equal(zoned("2026-10-03", "10:14").toISOString(), "2026-10-03T17:14:00.000Z");
  assert.equal(zoned("2026-03-01", "10:14").toISOString(), "2026-03-01T18:14:00.000Z"); // PST
  assert.equal(zoned("2026-12-15", "10:14").toISOString(), "2026-12-15T17:14:00.000Z"); // permanent UTC-7
  assert.equal(zoned("2025-12-15", "10:14").toISOString(), "2025-12-15T18:14:00.000Z");
  assert.equal(hourKey(new Date("2026-12-15T17:14:00Z")), "2026-12-15T10:00");
  assert.equal(localDate(new Date("2026-03-08T07:30:00Z")), "2026-03-07");
});

const CLEAR_TAF = "TAF CYCG 151140Z 1512/1600 VRB03KT P6SM SKC";
test("a clear forecast pulls risk below the seasonal base; no forecast leaves it at base", () => {
  const now = new Date("2026-12-15T12:00Z");
  const [none] = day("2026-12-15", { now });
  const [clear] = day("2026-12-15", { now, taf: parseTaf(CLEAR_TAF, now) });
  assert.ok(Math.abs(none.p - none.factors[0].p) < 1e-9);
  assert.ok(clear.p < none.p / 1.5);
});

test("ceiling, visibility and fog are not stacked", () => {
  const now = new Date("2026-12-15T12:00Z");
  const fog = parseTaf("TAF CYCG 151140Z 1512/1600 00000KT 1/4SM FG VV002", now);
  const [a] = day("2026-12-15", { now, taf: fog });
  assert.equal(a.factors.filter((f) => !f.isBase).length, 1);
  assert.ok(a.p > 0.6 && a.p < 0.95, `p=${a.p}`);
});

test("model evidence shrinks toward the base as lead time grows", () => {
  const fc = [{ time: "2026-12-15T10:00", cloud_cover_low: 100, visibility: 20000, snowfall: 0, weather_code: 3, wind_speed_10m: 3, wind_gusts_10m: 5 }];
  const at = (iso) => day("2026-12-15", { now: new Date(iso), forecast: fc })[0];
  const near = at("2026-12-15T15:00Z"), far = at("2026-12-13T15:00Z");
  assert.ok(near.p > far.p && far.p > far.factors[0].p, `${near.p} ${far.p}`);
  assert.ok(far.modelWeight < 0.3);
});

test("a low-cloud METAR two hours out still counts, at reduced weight", () => {
  const now = new Date("2026-10-03T15:05Z");
  const metar = parseMetar("METAR CYCG 031500Z 02006KT 15SM OVC016 12/09 A3010", now);
  const [a] = day("2026-10-03", { now, metar });
  const f = a.factors.find((x) => x.label.startsWith("ceiling"));
  assert.ok(f && f.v > 0 && f.v < 1.2, JSON.stringify(f));
  assert.ok(a.sources.includes("METAR"));
});

test("BECMG in transition counts the worse state; BCFG does not cancel FG", () => {
  const now = new Date("2026-12-15T12:00Z");
  const becmg = parseTaf("TAF CYCG 151140Z 1512/1600 VRB03KT P6SM SKC BECMG 1517/1519 OVC008", now);
  const [a] = day("2026-12-15", { now, taf: becmg }); // arrival 18:14Z, mid-transition
  assert.ok(a.factors.some((f) => f.label.startsWith("BECMG")), JSON.stringify(a.factors));
  const fg = parseTaf("TAF CYCG 151140Z 1512/1600 00000KT 1/2SM FG BCFG OVC003", now);
  assert.ok(day("2026-12-15", { now, taf: fg })[0].factors.some((f) => /fog/.test(f.label)));
});

test("ensemble spread gives a range around the estimate", () => {
  const now = new Date("2026-12-13T15:00Z");
  const run = (low) => ({ cloud_cover_low: low, weather_code: low > 90 ? 45 : 3, snowfall: 0, wind_speed_10m: 3, wind_gusts_10m: 5 });
  const ensemble = { "2026-12-15T10:00": [...Array(30).fill(run(10)), ...Array(21).fill(run(100))] };
  const [a, d] = day("2026-12-15", { now, ensemble, forecast: [{ time: "2026-12-15T10:00", ...run(10), visibility: 20000 }] });
  assert.ok(a.range && a.range[0] < a.p && a.p < a.range[1], JSON.stringify([a.range, a.p]));
  assert.ok(d.range && d.range[1] >= a.range[1]);
  assert.ok(a.sources.includes("ensemble"));
});

test("predictions are logged once per lead window", async () => {
  const { leadBucket } = await import("./predict.mjs");
  assert.deepEqual([47, 24.5, 13, 0.5, 49, 0].map(leadBucket), [48, 48, 24, 1, null, null]);
});
