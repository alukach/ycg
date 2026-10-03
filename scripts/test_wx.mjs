// Outlook tests: node --test scripts/test_wx.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseMetar, parseTaf, tafAt, predictDay, zoned } from "../assets/wx.js";

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
  assert.equal(zoned("2026-12-15", "10:14").toISOString(), "2026-12-15T18:14:00.000Z");
});
