// Cost model for an LLM feature: per-request token math, prompt caching,
// batch discounts, and routing easy traffic to a cheaper model. No DOM code.

// USD per million tokens. Taken from Anthropic's published model pricing in
// November 2026. Check the pricing page before relying on these.
// Cache reads are per model. Cache writes are a multiple of the input price.
export const MODELS = {
  "claude-fable-5-1": { label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5 charges more when one request's prompt is over 100K tokens.
  // Its cache read price is assumed at the usual 0.1x of input.
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};
export const MODEL_IDS = Object.keys(MODELS);
export const CACHE_WRITE = { "5m": 1.25, "1h": 2 };
export const TTL_SECONDS = { "5m": 300, "1h": 3600 };
export const BATCH_DISCOUNT = 0.5;
export const MIN_CACHEABLE = 512;
export const DAYS_PER_MONTH = 30;

export const DEFAULT_INPUTS = {
  model: "claude-sonnet-5-5",
  tasksPerDay: 20000,
  prefixTokens: 6000, // system prompt, tool definitions, examples: identical on every request
  inputTokens: 800, // new input per turn: the user's message, retrieved text, tool results
  outputTokens: 400, // per turn, including thinking
  turns: 3, // model calls per task; each one re-sends the conversation so far
  caching: true,
  ttl: "5m",
  batchShare: 0.2, // share of tasks nobody waits on, sent through the Batch API
  routeShare: 0.4, // share of tasks simple enough for the router model
  routeModel: "claude-haiku-5-5",
};

/**
 * Chance that the shared prefix is still cached when a task starts.
 * Tasks arrive at random, so the gap since the last one is exponential.
 * Every read refreshes the entry, so it stays warm while gaps stay under the TTL.
 */
export function prefixHitRate(tasksPerDay, ttl) {
  const perSecond = tasksPerDay / 86400;
  return 1 - Math.exp(-perSecond * TTL_SECONDS[ttl]);
}

/**
 * Tokens for one task, split by how each is billed. Turn t sends the prefix,
 * every earlier turn's input and output, and its own new input.
 *
 * With caching on, the prefix is a read when warm and a write when cold.
 * In multi-turn tasks the conversation is cached as it grows: each turn reads
 * what earlier turns wrote and writes only what is new. The last turn's new
 * tokens are never read again, so they are not written.
 */
export function taskTokens({ prefixTokens: P, inputTokens: V, outputTokens: O, turns: T, caching }, hitRate) {
  const turns = [];
  const cachePrefix = caching && P >= MIN_CACHEABLE;
  for (let t = 1; t <= T; t++) {
    const history = (t - 1) * (V + O);
    const fresh = V; // this turn's new input
    const total = P + history + fresh;
    let regular = 0, write = 0, read = 0;
    if (cachePrefix) {
      read += P * hitRate;
      write += P * (1 - hitRate);
    } else regular += P;
    if (caching && T > 1) {
      // Cached so far: every earlier turn's input and every output before the previous one.
      // The previous turn's output is new to the cache now.
      if (t >= 2) read += (t - 1) * V + (t - 2) * O;
      const delta = fresh + (t >= 2 ? O : 0);
      if (t < T) write += delta;
      else regular += delta;
    } else regular += history + fresh;
    turns.push({ turn: t, total, regular, write, read, output: O });
  }
  return turns;
}

function rates(model, promptTokens) {
  const m = MODELS[model];
  if (!m) throw new Error(`Unknown model ${model}`);
  return m.long && promptTokens > m.long.above ? m.long : m;
}

/** Dollar cost of one task, broken down by line item. */
export function taskCost(model, inputs, hitRate) {
  const cost = { regular: 0, write: 0, read: 0, output: 0 };
  const tokens = { regular: 0, write: 0, read: 0, output: 0 };
  const mult = CACHE_WRITE[inputs.ttl];
  for (const turn of taskTokens(inputs, hitRate)) {
    const r = rates(model, turn.total);
    cost.regular += (turn.regular * r.input) / 1e6;
    cost.write += (turn.write * r.input * mult) / 1e6;
    cost.read += (turn.read * r.cacheRead) / 1e6;
    cost.output += (turn.output * r.output) / 1e6;
    for (const k of Object.keys(tokens)) tokens[k] += turn[k];
  }
  const total = cost.regular + cost.write + cost.read + cost.output;
  return { cost, tokens, total };
}

/** Monthly cost with every setting applied: caching, batch share, and routing. */
export function monthly(inputs, model = inputs.model) {
  const hit = inputs.caching ? prefixHitRate(inputs.tasksPerDay, inputs.ttl) : 0;
  const tasks = inputs.tasksPerDay * DAYS_PER_MONTH;
  const routed = model === inputs.routeModel ? 0 : inputs.routeShare;
  const main = taskCost(model, inputs, hit);
  // Routed traffic has its own, smaller stream, so its prefix cache is colder.
  const routeHit = inputs.caching ? prefixHitRate(inputs.tasksPerDay * routed, inputs.ttl) : 0;
  const side = routed > 0 ? taskCost(inputs.routeModel, inputs, routeHit) : null;
  const batchFactor = 1 - inputs.batchShare * BATCH_DISCOUNT;
  const mainTasks = tasks * (1 - routed);
  const sideTasks = tasks * routed;
  const lines = {};
  for (const k of ["regular", "write", "read", "output"]) {
    lines[k] = (main.cost[k] * mainTasks + (side ? side.cost[k] * sideTasks : 0)) * batchFactor;
  }
  const total = lines.regular + lines.write + lines.read + lines.output;
  return { total, lines, perTask: total / tasks, hitRate: hit, tokensPerTask: main.tokens, routed };
}

/**
 * The same workload with optimizations added one at a time, so each step
 * shows what it is worth on its own.
 */
export function savingsLadder(inputs) {
  const base = { ...inputs, caching: false, batchShare: 0, routeShare: 0 };
  const steps = [{ key: "base", label: "No optimizations", inputs: base }];
  if (inputs.caching) steps.push({ key: "cache", label: `Prompt caching (${inputs.ttl} TTL)`, inputs: { ...steps.at(-1).inputs, caching: true, ttl: inputs.ttl } });
  if (inputs.batchShare > 0) steps.push({ key: "batch", label: `Batch API for ${Math.round(inputs.batchShare * 100)}% of tasks`, inputs: { ...steps.at(-1).inputs, batchShare: inputs.batchShare } });
  if (inputs.routeShare > 0 && inputs.routeModel !== inputs.model) steps.push({ key: "route", label: `${Math.round(inputs.routeShare * 100)}% routed to ${MODELS[inputs.routeModel].label}`, inputs: { ...steps.at(-1).inputs, routeShare: inputs.routeShare } });
  return steps.map((s) => ({ key: s.key, label: s.label, total: monthly(s.inputs).total }));
}

/** Every model priced on the same workload and settings. */
export function compareModels(inputs) {
  return MODEL_IDS.map((id) => ({ id, label: MODELS[id].label, ...monthly({ ...inputs, routeShare: 0 }, id) }));
}

/** Requests at which caching the prefix starts to pay for itself, for a single-turn task. */
export function breakEvenTasksPerDay(inputs) {
  // Caching wins when hit * (input - read) > (1 - hit) * (write - 1) * input, per prefix token.
  const m = MODELS[inputs.model];
  const w = CACHE_WRITE[inputs.ttl];
  const hit = (m.input * (w - 1)) / (m.input * (w - 1) + (m.input - m.cacheRead));
  // Invert hit = 1 - exp(-rate * ttl).
  return (-Math.log(1 - hit) / TTL_SECONDS[inputs.ttl]) * 86400;
}

export function encodeInputs(inputs) {
  return new URLSearchParams(Object.entries(inputs).map(([k, v]) => [k, String(v)])).toString();
}

export function decodeInputs(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const out = { ...DEFAULT_INPUTS };
  for (const [k, def] of Object.entries(DEFAULT_INPUTS)) {
    if (!p.has(k)) continue;
    const raw = p.get(k);
    if (typeof def === "boolean") out[k] = raw === "true";
    else if (typeof def === "number") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (k === "ttl" ? raw in CACHE_WRITE : raw in MODELS) out[k] = raw;
  }
  out.turns = Math.max(1, Math.round(out.turns));
  out.batchShare = Math.min(1, out.batchShare);
  out.routeShare = Math.min(1, out.routeShare);
  return out;
}

export function fmtUsd(n) {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toPrecision(2)}`;
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return Math.round(n).toLocaleString("en-US");
}
