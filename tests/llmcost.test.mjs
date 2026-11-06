import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUTS, MODELS, breakEvenTasksPerDay, compareModels, decodeInputs, encodeInputs, fmtUsd,
  monthly, prefixHitRate, savingsLadder, taskCost, taskTokens,
} from "../src/llmcost.js";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const one = { prefixTokens: 1000, inputTokens: 100, outputTokens: 50, turns: 1, caching: false, ttl: "5m" };

test("single turn without caching is plain input and output pricing", () => {
  const { cost, total } = taskCost("claude-opus-5-5", one, 0);
  near(cost.regular, (1100 * 4) / 1e6);
  near(cost.output, (50 * 20) / 1e6);
  near(total, cost.regular + cost.output);
});

test("multi-turn tasks re-send the growing conversation", () => {
  const turns = taskTokens({ ...one, turns: 3 }, 0);
  assert.deepEqual(turns.map((t) => t.total), [1100, 1250, 1400]);
  assert.deepEqual(turns.map((t) => t.regular), [1100, 1250, 1400]);
});

test("cached tokens add up to the full prompt on every turn", () => {
  for (const hit of [0, 0.4, 1]) {
    for (const t of taskTokens({ ...one, turns: 4, caching: true }, hit)) {
      near(t.regular + t.write + t.read, t.total, 1e-9);
    }
  }
});

test("caching reads earlier turns and writes only what is new", () => {
  const [t1, t2, t3] = taskTokens({ ...one, turns: 3, caching: true }, 1);
  assert.deepEqual([t1.read, t1.write, t1.regular], [1000, 100, 0]);
  // Turn 2 reads the prefix and turn 1's input, writes turn 1's output plus its own input.
  assert.deepEqual([t2.read, t2.write, t2.regular], [1100, 150, 0]);
  // The last turn's new tokens are never read again, so they are not written.
  assert.deepEqual([t3.read, t3.write, t3.regular], [1250, 0, 150]);
});

test("a prefix below the cache minimum is not cached", () => {
  const [t] = taskTokens({ ...one, prefixTokens: 300, caching: true }, 1);
  assert.equal(t.read, 0);
  assert.equal(t.regular, 400);
});

test("cache writes cost 1.25x for 5 minutes and 2x for 1 hour", () => {
  const cold5 = taskCost("claude-sonnet-5-5", { ...one, caching: true }, 0);
  const cold60 = taskCost("claude-sonnet-5-5", { ...one, caching: true, ttl: "1h" }, 0);
  near(cold5.cost.write, (1000 * 2 * 1.25) / 1e6);
  near(cold60.cost.write, (1000 * 2 * 2) / 1e6);
  const warm = taskCost("claude-sonnet-5-5", { ...one, caching: true }, 1);
  near(warm.cost.read, (1000 * 0.2) / 1e6);
});

test("hit rate follows the gap between tasks", () => {
  near(prefixHitRate(86400 / 300, "5m"), 1 - Math.exp(-1));
  assert.ok(prefixHitRate(100000, "5m") > 0.999);
  assert.ok(prefixHitRate(10, "1h") > prefixHitRate(10, "5m"));
  assert.equal(prefixHitRate(0, "5m"), 0);
});

test("Haiku charges its long-context rate above 100K prompt tokens", () => {
  const small = taskCost("claude-haiku-5-5", { ...one, prefixTokens: 99_000 }, 0);
  const big = taskCost("claude-haiku-5-5", { ...one, prefixTokens: 101_000 }, 0);
  near(small.cost.regular, (99_100 * 0.1) / 1e6);
  near(big.cost.regular, (101_100 * 0.5) / 1e6);
  near(big.cost.output, (50 * 2.5) / 1e6);
});

test("monthly multiplies by volume and applies the batch discount", () => {
  const inputs = { ...DEFAULT_INPUTS, caching: false, batchShare: 0, routeShare: 0, turns: 1 };
  const m = monthly(inputs);
  near(m.total, taskCost(inputs.model, inputs, 0).total * inputs.tasksPerDay * 30, 1e-6);
  const half = monthly({ ...inputs, batchShare: 1 });
  near(half.total, m.total / 2, 1e-6);
});

test("routing sends a share of tasks to the cheaper model", () => {
  const inputs = { ...DEFAULT_INPUTS, model: "claude-opus-5-5", caching: false, routeShare: 0.5 };
  const opus = monthly({ ...inputs, routeShare: 0 }).total;
  const haiku = monthly({ ...inputs, routeShare: 0 }, "claude-haiku-5-5").total;
  near(monthly(inputs).total, (opus + haiku) / 2, 1e-6);
});

test("the savings ladder only goes down and starts at the unoptimized cost", () => {
  const inputs = { ...DEFAULT_INPUTS, batchShare: 0.3, routeShare: 0.4 };
  const ladder = savingsLadder(inputs);
  assert.deepEqual(ladder.map((s) => s.key), ["base", "cache", "batch", "route"]);
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i].total < ladder[i - 1].total);
  near(ladder.at(-1).total, monthly(inputs).total, 1e-6);
});

test("caching saves most of the input bill at high volume", () => {
  const on = monthly(DEFAULT_INPUTS);
  const off = monthly({ ...DEFAULT_INPUTS, caching: false });
  assert.ok(on.hitRate > 0.99);
  assert.ok(on.total < off.total * 0.6);
});

test("caching can cost more than it saves at very low volume", () => {
  const lonely = { ...DEFAULT_INPUTS, tasksPerDay: 5, turns: 1, ttl: "1h" };
  assert.ok(monthly(lonely).total > monthly({ ...lonely, caching: false }).total);
});

test("break-even volume is where caching stops costing extra", () => {
  const inputs = { ...DEFAULT_INPUTS, turns: 1, inputTokens: 0, outputTokens: 0 };
  const be = breakEvenTasksPerDay(inputs);
  const at = (n) => monthly({ ...inputs, tasksPerDay: n }).total - monthly({ ...inputs, tasksPerDay: n, caching: false }).total;
  assert.ok(at(be * 0.8) > 0);
  assert.ok(at(be * 1.2) < 0);
});

test("model comparison is ordered by price per token", () => {
  const rows = compareModels({ ...DEFAULT_INPUTS, caching: false });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.total]));
  assert.ok(byId["claude-fable-5-1"] > byId["claude-opus-5-5"]);
  assert.ok(byId["claude-opus-5-5"] > byId["claude-sonnet-5-5"]);
  assert.ok(byId["claude-sonnet-5-5"] > byId["claude-haiku-5-5"]);
  assert.equal(rows.length, Object.keys(MODELS).length);
});

test("inputs round-trip through the URL and invalid values fall back", () => {
  const inputs = { ...DEFAULT_INPUTS, model: "claude-opus-5-5", caching: false, ttl: "1h", turns: 5, batchShare: 0.25 };
  assert.deepEqual(decodeInputs(`#${encodeInputs(inputs)}`), inputs);
  const bad = decodeInputs("#model=gpt&ttl=2h&turns=0&batchShare=7&tasksPerDay=-3");
  assert.equal(bad.model, DEFAULT_INPUTS.model);
  assert.equal(bad.ttl, DEFAULT_INPUTS.ttl);
  assert.equal(bad.turns, 1);
  assert.equal(bad.batchShare, 1);
  assert.equal(bad.tasksPerDay, DEFAULT_INPUTS.tasksPerDay);
});

test("money formatting", () => {
  assert.equal(fmtUsd(12345.6), "$12,346");
  assert.equal(fmtUsd(12.345), "$12.35");
  assert.equal(fmtUsd(0.0123), "$0.012");
  assert.equal(fmtUsd(0.00042), "$0.00042");
});
