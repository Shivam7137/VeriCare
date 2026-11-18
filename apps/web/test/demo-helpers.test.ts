import assert from "node:assert/strict";
import test from "node:test";
import { deltaText, sparkline, speedHint } from "../lib/demo";

test("the sparkline needs two points and survives a flat line", () => {
  assert.equal(sparkline([], 80, 24), null);
  assert.equal(sparkline([40], 80, 24), null);
  const flat = sparkline([40, 40, 40], 80, 24)!;
  assert.doesNotMatch(flat.line, /NaN|Infinity/);
  const rising = sparkline([10, 20, 40], 80, 24, 3)!;
  assert.equal(rising.line.startsWith("M3.0 21.0"), true);
  // The highest value sits at the top edge, and the area closes along the bottom.
  assert.deepEqual(rising.last, { x: 77, y: 3 });
  assert.equal(rising.area.endsWith("L3.0 24 Z"), true);
});

test("the change line reads like a person would say it", () => {
  assert.equal(deltaText(48, 87), "+39 min");
  assert.equal(deltaText(87, 48), "−39 min");
  assert.equal(deltaText(48, 48), null);
  assert.equal(deltaText(null, 48), null);
  assert.equal(deltaText(48, null), null);
});

test("every speed has a plain-words hint", () => {
  assert.equal(speedHint(1), "real time");
  assert.equal(speedHint(10), "1 min every 6 s");
  assert.equal(speedHint(60), "1 min per second");
  assert.equal(speedHint(300), "5 min per second");
});
