import {
  DEFAULT_INPUTS, MODELS, MODEL_IDS, breakEvenTasksPerDay, compareModels, decodeInputs, encodeInputs,
  fmtTokens, fmtUsd, monthly, savingsLadder,
} from "./llmcost.js";

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

let inputs = decodeInputs(location.hash);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const pct = (x) => `${Math.round(x * 100)}%`;

for (const id of ["model", "routeModel"]) {
  $(id).replaceChildren(...MODEL_IDS.map((m) => el("option", { value: m, text: MODELS[m].label })));
}

function fillForm() {
  for (const field of form.elements) {
    if (!field.name) continue;
    if (field.type === "checkbox") field.checked = inputs[field.name];
    else field.value = inputs[field.name];
  }
}

function card(label, value, sub) {
  return el("div", { class: "card" }, [el("span", { class: "card-label", text: label }), el("span", { class: "card-total", text: value }), el("span", { class: "card-sub", text: sub })]);
}

function update() {
  for (const k of ["batchShare", "routeShare"]) document.querySelector(`output[data-for="${k}"]`).textContent = pct(inputs[k]);
  form.elements.ttl.disabled = !inputs.caching;
  form.elements.routeModel.disabled = inputs.routeShare === 0;

  const m = monthly(inputs);
  const t = m.tokensPerTask;
  const tokensPerTask = t.regular + t.write + t.read + t.output;
  $("cards").replaceChildren(
    card("Monthly cost", fmtUsd(m.total), `${inputs.tasksPerDay.toLocaleString("en-US")} tasks a day, 30 days`),
    card("Cost per task", fmtUsd(m.perTask), `${inputs.turns} model call${inputs.turns > 1 ? "s" : ""} per task`),
    card("Prefix cache hits", inputs.caching ? pct(m.hitRate) : "off", inputs.caching ? `of tasks find the prefix warm (${inputs.ttl} lifetime)` : "turn on caching to compare"),
    card("Tokens per task", fmtTokens(tokensPerTask), `${fmtTokens(t.output)} of them output`),
  );

  const warnings = [];
  if (inputs.caching && inputs.prefixTokens > 0 && inputs.prefixTokens < 512) warnings.push("Prefixes under 512 tokens are not cached, so caching changes nothing here.");
  if (inputs.caching && m.hitRate < 0.5 && inputs.turns === 1) {
    const be = breakEvenTasksPerDay(inputs);
    warnings.push(`At this volume most tasks find the cache cold and pay the write premium. Caching the prefix pays off above about ${Math.ceil(be).toLocaleString("en-US")} tasks a day with the ${inputs.ttl} lifetime.`);
  }
  if (inputs.model === "claude-haiku-5-5" && inputs.prefixTokens + inputs.turns * (inputs.inputTokens + inputs.outputTokens) > 100_000) warnings.push("Some calls go over 100K prompt tokens, where Haiku 5.5 charges its higher long-context rate.");
  $("warnings").replaceChildren(...warnings.map((w) => el("li", { text: w })));

  const lines = [
    ["Input, not cached", t.regular, m.lines.regular],
    ["Cache writes", t.write, m.lines.write],
    ["Cache reads", t.read, m.lines.read],
    ["Output", t.output, m.lines.output],
  ];
  $("lines").replaceChildren(...lines.map(([name, tok, usd]) => el("tr", {}, [el("td", { text: name }), el("td", { class: "num", text: fmtTokens(tok) }), el("td", { class: "num", text: fmtUsd(usd) })])));
  $("lines-total").textContent = fmtUsd(m.total);

  const rows = compareModels(inputs);
  const top = Math.max(...rows.map((r) => r.total));
  $("models").replaceChildren(
    ...rows.map((r) => el("tr", { class: r.id === inputs.model ? "current" : "" }, [
      el("td", { text: r.label + (r.id === inputs.model ? " (selected)" : "") }),
      el("td", { class: "num", text: fmtUsd(r.perTask) }),
      el("td", { class: "num" }, [el("i", { class: "mbar", style: `width:${Math.max(2, (r.total / top) * 70)}px` }), fmtUsd(r.total)]),
    ])),
  );

  drawLadder();
  history.replaceState(null, "", `#${encodeInputs(inputs)}`);
}

function drawLadder() {
  const steps = savingsLadder(inputs);
  const chart = $("ladder");
  const rowH = 40, labelW = 230, valueW = 170;
  const W = 760, H = steps.length * rowH + 8;
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = steps[0].total || 1;
  const barW = (v) => Math.max(2, (v / max) * (W - labelW - valueW));
  const nodes = [];
  steps.forEach((s, i) => {
    const y = i * rowH + 6;
    const w = barW(s.total);
    nodes.push(svg("text", { x: 0, y: y + 18, class: "lbl" }, s.label));
    // Bars are anchored at the left baseline; only the data end is rounded.
    nodes.push(svg("path", { d: roundedBar(labelW, y + 4, w, 20, 4), class: `bar${i === 0 ? " base" : ""}` }));
    nodes.push(svg("text", { x: labelW + w + 8, y: y + 18, class: "val" }, fmtUsd(s.total)));
    if (i > 0) {
      const saved = steps[i - 1].total - s.total;
      nodes.push(svg("text", { x: labelW + w + 8 + fmtUsd(s.total).length * 7.5 + 8, y: y + 18, class: "save" }, `saves ${fmtUsd(saved)}`));
    }
  });
  chart.replaceChildren(...nodes);
  const first = steps[0].total, last = steps.at(-1).total;
  $("ladder-note").textContent = steps.length === 1
    ? "Turn on caching, batching, or routing to see what each one saves."
    : `Together these cut the bill by ${pct(1 - last / first)}, from ${fmtUsd(first)} to ${fmtUsd(last)} a month. Each bar adds one change to the one above it.`;
}

function roundedBar(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  let v;
  if (f.type === "checkbox") v = f.checked;
  else if (f.tagName === "SELECT") v = f.value;
  else {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
    if (f.name === "turns") v = Math.max(1, Math.round(v));
  }
  inputs = { ...inputs, [f.name]: v };
  update();
});

$("reset").addEventListener("click", () => {
  inputs = { ...DEFAULT_INPUTS };
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();
