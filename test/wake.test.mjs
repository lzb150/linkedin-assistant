import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDarkWake, parseOnAC, darkWakeOnBattery } from "../lib/wake.mjs";

const FULL = "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n";
const DARK = "Current System Capabilities are: CPU Network Disk \nCurrent Power State: 4\n";
const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;\n";
const BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging;\n";
const pmset = (state, batt) => (arg) => (arg === "systemstate" ? state : batt);

test("parseDarkWake: a capabilities line without Graphics is a DarkWake", () => {
  assert.equal(parseDarkWake(FULL), false);
  assert.equal(parseDarkWake(DARK), true);
});

test("parseDarkWake: no capabilities line at all is not a DarkWake (never skip on a guess)", () => {
  assert.equal(parseDarkWake(""), false);
  assert.equal(parseDarkWake(undefined), false);
  assert.equal(parseDarkWake("pmset: unknown option"), false);
});

test("parseOnAC reads the power source line", () => {
  assert.equal(parseOnAC(AC), true);
  assert.equal(parseOnAC(BATT), false);
  assert.equal(parseOnAC(""), false);
});

test("darkWakeOnBattery: only a DarkWake on battery defers LinkedIn", () => {
  assert.equal(darkWakeOnBattery(pmset(DARK, BATT)), true);
  assert.equal(darkWakeOnBattery(pmset(DARK, AC)), false, "on AC caffeinate -s holds the Mac up");
  assert.equal(darkWakeOnBattery(pmset(FULL, BATT)), false);
});

test("darkWakeOnBattery: pmset missing or failing answers false", () => {
  assert.equal(darkWakeOnBattery(() => { throw new Error("spawnSync pmset ENOENT"); }), false);
});
