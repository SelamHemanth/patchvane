/* Patchvane UI engine: handlers, motion, charts and the data grid.
   Loaded before app.js, which holds the data and the views. */

/* --------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ago(iso) {
  if (!iso) return "\u2014";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "\u2014";
  const d = Math.max(0, (Date.now() - then) / 1000);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  const days = Math.floor(d / 86400);
  if (days < 31) return days + " day" + (days === 1 ? "" : "s") + " ago";
  const mo = Math.floor(days / 30);
  return mo + " month" + (mo === 1 ? "" : "s") + " ago";
}

const day = (iso) => (iso || "").slice(0, 10) || "\u2014";

function pct(n, total) {
  return total ? Math.round((n / total) * 100) + "%" : "0%";
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : (many || one + "s"));
}

/* ------------------------------------------------------------- handlers */

/* Views are built as HTML strings, which used to mean onclick="..." all over
   the markup.  That forces script-src 'unsafe-inline', and unsafe-inline is
   exactly the backstop you want on a page that renders subject lines written
   by strangers.  So a handler is stored here as a closure and the markup
   carries only the key that finds it again. */
const CMD = new Map();
let CMD_N = 0;

/* The element and the event are handed on as trailing arguments, so a handler
   that cares about them (shift-click to add a second sort) can ask, and the
   many that do not can ignore them. */
function act(fn, ...args) {
  const id = "c" + (++CMD_N);
  CMD.set(id, (el, e) => fn(...args, el, e));
  return `data-cmd="${id}"`;
}

/* For a select, a checkbox or a text field, where the handler wants whatever
   the user just entered. */
function actv(evt, fn, ...args) {
  const id = "c" + (++CMD_N);
  CMD.set(id, (el) =>
    fn(...args, el.type === "checkbox" ? el.checked : el.value));
  return `data-cmd="${id}" data-on="${evt}"`;
}

function fire(e, want) {
  const el = e.target.closest ? e.target.closest("[data-cmd]") : null;
  if (!el || (el.dataset.on || "click") !== want) return;
  const fn = CMD.get(el.dataset.cmd);
  if (!fn) return;
  if (want === "click") {
    e.preventDefault();
    ripple(el, e);
  }
  fn(el, e);
}

function bindHandlers() {
  document.addEventListener("click", (e) => fire(e, "click"));
  document.addEventListener("change", (e) => fire(e, "change"));
  document.addEventListener("input", (e) => fire(e, "input"));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest && e.target.closest("[data-cmd][tabindex]");
    if (!el) return;
    e.preventDefault();
    const fn = CMD.get(el.dataset.cmd);
    if (fn) fn(el, e);
  });
}

/* ---------------------------------------------------------------- motion */

/* Someone who has asked their system to stop animating things means it, so
   every effect below checks here first rather than being merely faster. */
const MOTION = {
  ok: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};
window.matchMedia("(prefers-reduced-motion: reduce)")
  .addEventListener("change", (e) => { MOTION.ok = !e.matches; });

/* Cross-fade the whole view where the browser can do it properly, and fall
   back to a plain re-render where it cannot. */
function transition(paint) {
  if (!MOTION.ok || !document.startViewTransition) { paint(); return; }
  document.startViewTransition(paint);
}

/* Panels and cards arrive in sequence instead of all at once.  Anything below
   the fold waits until it is actually scrolled to. */
let REVEALER = null;

function reveal(root) {
  if (!MOTION.ok) {
    (root || document).querySelectorAll("[data-reveal]")
      .forEach((el) => el.classList.add("seen"));
    return;
  }
  if (!REVEALER) {
    REVEALER = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("seen");
        REVEALER.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.02 });
  }
  let i = 0;
  (root || document).querySelectorAll("[data-reveal]:not(.seen)")
    .forEach((el) => {
      el.style.setProperty("--i", i++ % 12);
      REVEALER.observe(el);
    });
}

/* First, Last, Invert, Play.  Sorting a table normally makes every row jump;
   this measures where each row was, lets the browser repaint, then animates
   each one from its old position to its new one so the eye can follow a row
   across a sort. */
function flip(container, selector, paint) {
  if (!MOTION.ok || !container) { paint(); return; }
  const before = new Map();
  container.querySelectorAll(selector).forEach((el) => {
    if (el.dataset.rk) before.set(el.dataset.rk, el.getBoundingClientRect().top);
  });

  paint();

  const moved = [];
  container.querySelectorAll(selector).forEach((el) => {
    const was = before.get(el.dataset.rk);
    if (was === undefined) {
      el.classList.add("rowin");
      return;
    }
    const now = el.getBoundingClientRect().top;
    const dy = was - now;
    if (Math.abs(dy) < 1) return;
    el.style.transform = `translateY(${dy}px)`;
    el.style.transition = "none";
    moved.push(el);
  });

  if (!moved.length) return;
  requestAnimationFrame(() => {
    moved.forEach((el) => {
      el.style.transition = "transform .42s cubic-bezier(.2,.8,.25,1)";
      el.style.transform = "";
      el.addEventListener("transitionend", () => {
        el.style.transition = "";
      }, { once: true });
    });
  });
}

/* Counters tick up the first time a given number appears, and only then. */
const COUNTED = new Set();

function counter(value, key) {
  return `<span class="value" data-count="${value}" data-ck="${esc(key)}">0</span>`;
}

function runCounters() {
  document.querySelectorAll("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const key = el.dataset.ck;
    if (!MOTION.ok || COUNTED.has(key)) {
      el.textContent = target.toLocaleString();
      return;
    }
    COUNTED.add(key);
    const started = performance.now(), span = 680;
    const tick = (now) => {
      const t = Math.min(1, (now - started) / span);
      el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)))
        .toLocaleString();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function ripple(el, e) {
  if (!MOTION.ok || !el.classList.contains("btn")) return;
  const box = el.getBoundingClientRect();
  const dot = document.createElement("span");
  dot.className = "ripple";
  const size = Math.max(box.width, box.height);
  dot.style.width = dot.style.height = size + "px";
  dot.style.left = (e.clientX - box.left - size / 2) + "px";
  dot.style.top = (e.clientY - box.top - size / 2) + "px";
  el.appendChild(dot);
  setTimeout(() => dot.remove(), 620);
}

/* Every state-changing call carries the header the server insists on, which
   is what stops another origin from posting here with your cookie. */
function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "patchvane" },
    body: JSON.stringify(body || {}),
  });
}

function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  $("toast").appendChild(el);
  setTimeout(() => el.classList.add("out"), 5200);
  setTimeout(() => el.remove(), 5800);
}

/* Charts and grids animate from a resting state that is set once they are in
   the document, so the browser has something to animate away from. */
function playIn(root) {
  const scope = root || document;
  requestAnimationFrame(() => {
    scope.querySelectorAll("[data-grow]").forEach((el) => {
      el.style.setProperty("--grown", "1");
    });
    scope.querySelectorAll("[data-sweep]").forEach((el) => {
      el.style.strokeDasharray = el.dataset.sweep;
    });
  });
}

/* ---------------------------------------------------------------- charts */

const CHARTS = new Map();

/* A chart cannot choose sensible tick spacing until it knows how wide it will
   be, and that is only true once it is in the document.  Views leave slots
   behind and mountCharts fills them in. */
function chartSlot(key, height, build) {
  CHARTS.set(key, build);
  return `<div class="chartslot" data-chart="${key}" style="height:${height}px"></div>`;
}

function mountCharts() {
  document.querySelectorAll("[data-chart]").forEach((el) => {
    const build = CHARTS.get(el.dataset.chart);
    if (!build) return;
    const w = Math.max(220, Math.floor(el.clientWidth));
    const h = parseInt(el.style.height, 10) || 200;
    el.innerHTML = build(w, h);
  });
  playIn();
}

/* The signature graphic: how patches flow from posted to mainline.  The band
   narrows at each stage in proportion to how many patches got that far. */
function funnel(stages, w, h) {
  const pad = { t: 34, b: 40 };
  const ih = h - pad.t - pad.b;
  const top = stages[0].value || 1;
  const cols = stages.length;
  const cw = w / cols;
  const cx = (i) => cw * i + cw / 2;
  /* a stage holding four patches out of 380 would otherwise be a hairline, so
     keep a floor on the band; the number above it carries the real scale */
  const half = (v) => Math.max(9, (v / top) * ih) / 2;
  const mid = pad.t + ih / 2;

  let defs = "", bands = "";
  for (let i = 0; i < cols - 1; i++) {
    const a = half(stages[i].value), b = half(stages[i + 1].value);
    defs += `<linearGradient id="fg${i}" x1="0" x2="1">
      <stop offset="0" stop-color="${stages[i].color}" stop-opacity="0.75"/>
      <stop offset="1" stop-color="${stages[i + 1].color}" stop-opacity="0.75"/>
    </linearGradient>`;
    bands += `<path class="fn-band" data-grow style="--d:${i * 70}ms;
      transform-origin:${cx(i)}px ${mid}px"
      d="M${cx(i)},${mid - a} L${cx(i + 1)},${mid - b}
         L${cx(i + 1)},${mid + b} L${cx(i)},${mid + a} Z"
      fill="url(#fg${i})"/>`;
  }

  let marks = "";
  stages.forEach((s, i) => {
    const a = half(s.value);
    marks += `<line class="fn-tick" data-grow style="--d:${i * 70}ms;
        transform-origin:${cx(i)}px ${mid}px"
        x1="${cx(i)}" y1="${mid - a}" x2="${cx(i)}" y2="${mid + a}"
        stroke="${s.color}" stroke-width="3" stroke-linecap="round"/>
      <text class="fn-v" x="${cx(i)}" y="${pad.t - 14}">${s.value}</text>
      <text class="fn-p" x="${cx(i)}" y="${h - 20}">${esc(s.label)}</text>
      <text class="fn-s" x="${cx(i)}" y="${h - 6}">${pct(s.value, top)} of posted</text>
      <rect x="${cw * i}" y="0" width="${cw}" height="${h}" fill="transparent">
        <title>${esc(s.label)}: ${plural(s.value, "patch", "patches")}, ${
          pct(s.value, top)} of everything posted.
${esc(s.hint || "")}</title></rect>`;
  });

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="funnel">
    <defs>${defs}</defs>${bands}${marks}</svg>`;
}

/* Calendar heatmap of posting activity, a week per column. */
function heatmap(byDate, weeks) {
  const cell = 13, gap = 3;
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - weeks * 7 + 1);

  let max = 0;
  Object.values(byDate).forEach((v) => { max = Math.max(max, v); });

  let cells = "", months = "", lastMonth = -1;
  for (let wi = 0; wi < weeks; wi++) {
    for (let di = 0; di < 7; di++) {
      const d = new Date(start);
      d.setDate(start.getDate() + wi * 7 + di);
      if (d > new Date()) continue;
      const iso = d.toISOString().slice(0, 10);
      const v = byDate[iso] || 0;
      const level = !v ? 0 : Math.min(4, Math.ceil((v / (max || 1)) * 4));
      cells += `<rect class="hm l${level}" data-grow style="--d:${wi * 12}ms"
        x="${wi * (cell + gap)}" y="${di * (cell + gap)}"
        width="${cell}" height="${cell}" rx="3">
        <title>${iso}: ${plural(v, "patch", "patches")} posted</title></rect>`;
      if (di === 0 && d.getMonth() !== lastMonth && d.getDate() <= 7) {
        lastMonth = d.getMonth();
        months += `<text class="axis" x="${wi * (cell + gap)}" y="-6">${
          d.toLocaleString("en", { month: "short" })}</text>`;
      }
    }
  }
  const w = weeks * (cell + gap), h = 7 * (cell + gap);
  return `<div class="hmwrap"><svg width="${w}" height="${h + 18}"
      viewBox="0 -16 ${w} ${h + 20}">${months}${cells}</svg>
    <div class="hmkey"><span>quiet</span>
      ${[0, 1, 2, 3, 4].map((l) => `<i class="hm l${l}"></i>`).join("")}
      <span>busy</span></div></div>`;
}

/* Progress ring, for a single rate that deserves its own graphic. */
function ring(value, total, label, size) {
  const r = size / 2 - 9, cx = size / 2, circ = 2 * Math.PI * r;
  const frac = total ? value / total : 0;
  const dash = `${(frac * circ).toFixed(1)} ${circ.toFixed(1)}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="ring">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none"
      stroke="var(--panel-2)" stroke-width="10"/>
    <circle class="rv-arc" cx="${cx}" cy="${cx}" r="${r}" fill="none"
      stroke="url(#ringgrad)" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="0 ${circ.toFixed(1)}" data-sweep="${dash}"
      transform="rotate(-90 ${cx} ${cx})"/>
    <defs><linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--blue)"/>
      <stop offset="1" stop-color="var(--green)"/></linearGradient></defs>
    <text class="rv" x="${cx}" y="${cx + 2}">${pct(value, total)}</text>
    <text class="rl" x="${cx}" y="${cx + 18}">${esc(label)}</text></svg>`;
}

function donut(items, size, centreValue, centreLabel) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const r = size / 2 - 13, cx = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0, arcs = "";
  items.forEach((it, i) => {
    const len = (it.value / total) * circ;
    arcs += `<circle class="arc" cx="${cx}" cy="${cx}" r="${r}" fill="none"
      stroke="${it.color}" stroke-width="16" style="--d:${i * 55}ms"
      stroke-dasharray="0 ${circ.toFixed(1)}"
      data-sweep="${Math.max(0, len - 1.5).toFixed(1)} ${(circ - len + 1.5).toFixed(1)}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cx})">
      <title>${esc(it.label)}: ${it.value}</title></circle>`;
    offset += len;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="16"/>
    ${arcs}<g class="donut-centre">
      <text class="n" x="${cx}" y="${cx + 2}">${esc(centreValue)}</text>
      <text class="t" x="${cx}" y="${cx + 16}">${esc(centreLabel || "")}</text>
    </g></svg>`;
}

function legend(items, total) {
  return `<ul class="legend">` + items.map((it, i) => `
    <li data-reveal style="--i:${i}">
      <span class="sw" style="background:${it.color}"></span>
      <span class="nm">${esc(it.label)}</span>
      <span class="vl">${it.value}</span>
      <span class="pc">${pct(it.value, total)}</span></li>`).join("") + `</ul>`;
}

/* Multi line chart. series: [{name, color, points:[y...]}], labels: [x...] */
function lineChart(labels, series, w, h) {
  const pad = { l: 34, r: 16, t: 12, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  let max = 0;
  for (const s of series) for (const v of s.points) max = Math.max(max, v);
  max = Math.max(max, 4);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const nice = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (labels.length < 2 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / nice) * ih;

  let grid = "", ylab = "";
  for (let g = 0; g <= 4; g++) {
    const v = (nice / 4) * g, yy = y(v);
    grid += `<line class="grid" x1="${pad.l}" y1="${yy}" x2="${w - pad.r}" y2="${yy}"/>`;
    ylab += `<text class="axis" x="${pad.l - 6}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }

  let paths = "";
  series.forEach((s, si) => {
    const pts = s.points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    if (!pts.length) return;
    if (s.fill) {
      paths += `<defs><linearGradient id="lg${si}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${s.color}" stop-opacity="0.30"/>
          <stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
        <path class="area" style="--d:${si * 120}ms"
          d="M${pad.l},${y(0)} L${pts.join(" L")} L${x(s.points.length - 1)},${y(0)} Z"
          fill="url(#lg${si})"/>`;
    }
    paths += `<polyline class="spark" style="--d:${si * 120}ms" points="${pts.join(" ")}"
      fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"
      stroke-linecap="round"/>`;
  });

  let xlab = "";
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(w / 74))));
  labels.forEach((l, i) => {
    if (i % every && i !== labels.length - 1) return;
    const anchor = i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle";
    xlab += `<text class="axis" x="${x(i)}" y="${h - 6}" text-anchor="${anchor}">${esc(l)}</text>`;
  });

  let hover = "";
  labels.forEach((l, i) => {
    const bw = labels.length < 2 ? iw : iw / (labels.length - 1);
    const tip = series.map((s) => `${s.name}: ${s.points[i]}`).join("\n");
    hover += `<rect class="hover-band" x="${x(i) - bw / 2}" y="${pad.t}"
      width="${bw}" height="${ih}"><title>${esc(l)}\n${esc(tip)}</title></rect>`;
  });

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${grid}${ylab}${paths}${xlab}${hover}</svg>`;
}

function stackBar(parts, total) {
  return `<div class="tr">` + parts.filter((p) => p.value > 0).map((p) =>
    `<i style="width:${(p.value / (total || 1)) * 100}%;background:${p.color}"
      title="${esc(p.label)}: ${p.value}"></i>`).join("") + `</div>`;
}

/* ------------------------------------------------------------------ grid */

/* One table implementation behind every list in the app, so a capability
   added here shows up everywhere at once. */

const GRIDS = {};

function gridState(id, opts) {
  if (GRIDS[id]) return GRIDS[id];
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("mainline-grid-" + id) || "{}");
  } catch (e) { saved = {}; }
  return (GRIDS[id] = {
    q: saved.q || "",
    page: 1,
    per: saved.per || opts.per || 10,
    sorts: saved.sorts || (opts.sort ? [{ key: opts.sort, dir: opts.dir || "desc" }] : []),
    filters: saved.filters || {},
    group: saved.group || "",
    hidden: saved.hidden || [],
    dense: !!saved.dense,
    collapsed: [],
    menu: "",
  });
}

function gridSave(id) {
  const s = GRIDS[id];
  try {
    localStorage.setItem("mainline-grid-" + id, JSON.stringify({
      q: s.q, per: s.per, sorts: s.sorts, filters: s.filters,
      group: s.group, hidden: s.hidden, dense: s.dense,
    }));
  } catch (e) { /* private browsing, not worth complaining about */ }
}

/* A small query language, because a single search box over four hundred rows
   is a blunt instrument.  `tree:net-next state:awaiting v>1 typo` reads the
   way you would say it out loud.  Anything it does not recognise as a field
   falls back to plain text, so it never gets in the way of just typing. */
function parseQuery(q) {
  const terms = [], text = [];
  const re = /(?:([a-z_]+)\s*(>=|<=|[:><=])\s*)?("[^"]*"|\S+)/gi;
  let m;
  while ((m = re.exec(q)) !== null) {
    const value = m[3].replace(/^"|"$/g, "").toLowerCase();
    if (!value) continue;
    if (m[1]) terms.push({ field: m[1].toLowerCase(), op: m[2], value });
    else text.push(value);
  }
  return { terms, text };
}

function matchQuery(row, parsed, opts) {
  const fields = opts.fields || {};
  for (const t of parsed.terms) {
    const get = fields[t.field];
    if (!get) {                       // unknown field, treat it as free text
      const hay = (opts.searchIn ? opts.searchIn(row) : "").toLowerCase();
      if (!hay.includes(t.field + t.op + t.value)) return false;
      continue;
    }
    const raw = get(row);
    if (t.op === ":" || t.op === "=") {
      if (!String(raw === null || raw === undefined ? "" : raw)
        .toLowerCase().includes(t.value)) return false;
    } else {
      const a = Number(raw), b = Number(t.value);
      if (isNaN(a) || isNaN(b)) return false;
      if (t.op === ">" && !(a > b)) return false;
      if (t.op === "<" && !(a < b)) return false;
      if (t.op === ">=" && !(a >= b)) return false;
      if (t.op === "<=" && !(a <= b)) return false;
    }
  }
  if (parsed.text.length) {
    const hay = (opts.searchIn ? opts.searchIn(row) : JSON.stringify(row))
      .toLowerCase();
    for (const w of parsed.text) if (!hay.includes(w)) return false;
  }
  return true;
}

/* Wrap whatever the user searched for, so the eye lands on it. */
let HL = [];

function mark(text) {
  const safe = esc(text);
  if (!HL.length) return safe;
  let out = safe;
  for (const w of HL) {
    if (w.length < 2) continue;
    out = out.replace(
      new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"),
      "<mark>$1</mark>");
  }
  return out;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  return a > b ? 1 : -1;
}

function grid(id, rows, cols, opts) {
  opts = opts || {};
  const st = gridState(id, opts);
  const shown = cols.filter((c) => !st.hidden.includes(c.key));

  const parsed = parseQuery(st.q);
  HL = parsed.text.slice();

  let data = rows.filter((r) => matchQuery(r, parsed, opts));
  for (const [k, v] of Object.entries(st.filters)) {
    if (!v) continue;
    const f = (opts.filters || []).find((x) => x.key === k);
    if (f) data = data.filter((r) => f.match(r, v));
  }

  if (st.sorts.length) {
    data = data.slice().sort((a, b) => {
      for (const s of st.sorts) {
        const col = cols.find((c) => c.key === s.key);
        if (!col) continue;
        const get = col.sort || ((r) => r[col.key]);
        const c = compare(get(a), get(b));
        if (c) return s.dir === "asc" ? c : -c;
      }
      return 0;
    });
  }

  /* How many rows survived the search and the filters, kept on the state so
     anything outside the grid can ask without repeating the work. */
  const total = st.total = data.length;
  const groupBy = (opts.groups || []).find((g) => g.key === st.group);

  /* Grouping shows every row in its group rather than paging through them,
     because a group split across two pages is worse than no grouping. */
  let bodyRows;
  if (groupBy) {
    const buckets = new Map();
    data.forEach((r) => {
      const k = groupBy.of(r) || "\u2014";
      (buckets.get(k) || buckets.set(k, []).get(k)).push(r);
    });
    const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    bodyRows = ordered.map(([name, list]) => {
      const shut = st.collapsed.includes(name);
      return `<tr class="grouprow" ${act(gridToggleGroup, id, name)}>
          <td colspan="${shown.length}">
            <span class="caret ${shut ? "shut" : ""}">\u25BE</span>
            <strong>${esc(name)}</strong>
            <span class="gcount">${plural(list.length, "row")}</span>
          </td></tr>` +
        (shut ? "" : list.map((r) => rowHtml(r, shown, opts)).join(""));
    }).join("");
    if (!ordered.length) bodyRows = emptyRow(id, shown.length, opts);
  } else {
    const pages = Math.max(1, Math.ceil(total / st.per));
    st.page = Math.min(st.page, pages);
    const start = (st.page - 1) * st.per;
    const view = data.slice(start, start + st.per);
    bodyRows = view.length ? view.map((r) => rowHtml(r, shown, opts)).join("")
                           : emptyRow(id, shown.length, opts);
  }

  const head = shown.map((c) => {
    const at = st.sorts.findIndex((s) => s.key === c.key);
    const s = at >= 0 ? st.sorts[at] : null;
    return `<th class="${c.sortable === false ? "" : "sortable"} ${c.cls || ""} ${
        s ? "sorted" : ""}"
      ${c.width ? `style="width:${c.width}"` : ""}
      ${c.sortable === false ? "" : act(gridSort, id, c.key)}
      title="${c.sortable === false ? "" : "Click to sort. Shift-click to add a second sort."}">
      ${esc(c.label)}${s ? `<span class="arrow">${
        s.dir === "asc" ? "\u25B2" : "\u25BC"}${
        st.sorts.length > 1 ? `<i>${at + 1}</i>` : ""}</span>` : ""}</th>`;
  }).join("");

  const active = Object.values(st.filters).filter(Boolean).length + (st.q ? 1 : 0);
  const pages = Math.max(1, Math.ceil(total / st.per));

  return `<div class="panel grid ${st.dense ? "dense" : ""}" data-grid="${id}" data-reveal>
    ${opts.title ? `<header><h2>${esc(opts.title)}</h2>
      ${opts.subtitle ? `<span class="sub">${esc(opts.subtitle)}</span>` : ""}
      <div class="spacer"></div>${opts.headerRight || ""}</header>` : ""}
    ${opts.chips || ""}
    <div class="toolbar">
      <div class="search ${st.q ? "on" : ""}">
        <span class="mag">\u2315</span>
        <input type="search" data-search="${id}" spellcheck="false"
          placeholder="${esc(opts.placeholder || "Search\u2026")}"
          value="${esc(st.q)}" ${actv("input", gridSearch, id)}>
        ${opts.fields ? `<button class="qhelp" ${act(gridHelp, id)}
          title="Query syntax">?</button>` : ""}
      </div>
      ${(opts.filters || []).map((f) => filterSelect(id, f, rows, st)).join("")}
      ${active ? `<button class="btn ghost sm" ${act(gridClear, id)}>Clear</button>` : ""}
      <div class="spacer"></div>
      ${(opts.groups || []).length ? `<div class="seg" title="Group rows">
        <button class="${!st.group ? "on" : ""}" ${act(gridGroup, id, "")}>flat</button>
        ${opts.groups.map((g) => `<button class="${st.group === g.key ? "on" : ""}"
          ${act(gridGroup, id, g.key)}>${esc(g.label)}</button>`).join("")}
      </div>` : ""}
      <button class="iconbtn sm ${st.dense ? "on" : ""}" ${act(gridDense, id)}
        title="${st.dense ? "Comfortable rows" : "Compact rows"}">\u2261</button>
      <button class="iconbtn sm" ${act(gridMenu, id, "cols")}
        title="Choose columns">\u229E</button>
      <button class="iconbtn sm" ${act(gridCsv, id, rows, cols, opts)}
        title="Download what is on screen as CSV">\u2913</button>
      ${st.menu === "cols" ? columnMenu(id, cols, st) : ""}
      ${st.menu === "help" ? queryHelp(id, opts) : ""}
    </div>
    <div class="tablewrap"><table><thead><tr>${head}</tr></thead>
      <tbody>${bodyRows}</tbody></table></div>
    ${groupBy
      ? `<div class="pager"><div class="spacer"></div>
           <span class="info">${plural(total, "row")} in ${
             plural(new Set(data.map((r) => groupBy.of(r))).size, "group")}</span></div>`
      : pager(id, st.page, pages, total, (st.page - 1) * st.per,
              Math.min(st.per, total - (st.page - 1) * st.per))}
  </div>`;
}

function rowHtml(r, cols, opts) {
  const key = opts.rowKey ? opts.rowKey(r) : "";
  return `<tr ${key ? `data-rk="${esc(key)}"` : ""}>` + cols.map((c) =>
    `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("") + `</tr>`;
}

function emptyRow(id, span, opts) {
  return `<tr><td colspan="${span}"><div class="empty">
    <div class="emptyicon">\u2205</div>
    <p>Nothing matches that.</p>
    <button class="btn" ${act(gridClear, id)}>Clear filters</button>
  </div></td></tr>`;
}

function filterSelect(id, f, rows, st) {
  const vals = f.values(rows);
  return `<select ${actv("change", gridFilter, id, f.key)}>
    <option value="">${esc(f.all)}</option>
    ${vals.map((v) => `<option value="${esc(v.value)}" ${
      st.filters[f.key] === v.value ? "selected" : ""}>${esc(v.label)}</option>`).join("")}
  </select>`;
}

function columnMenu(id, cols, st) {
  return `<div class="menu">
    <h4>Columns</h4>
    ${cols.filter((c) => c.label).map((c) => `<label class="check">
      <input type="checkbox" ${st.hidden.includes(c.key) ? "" : "checked"}
        ${actv("change", gridColumn, id, c.key)}> ${esc(c.label)}</label>`).join("")}
    <button class="btn ghost sm" ${act(gridMenu, id, "")}>Done</button>
  </div>`;
}

function queryHelp(id, opts) {
  const fields = Object.keys(opts.fields || {});
  return `<div class="menu wide">
    <h4>Search</h4>
    <p>Type words to match anywhere, or narrow it down by field.</p>
    <ul class="qsyntax">
      <li><code>tree:net-next</code> only that tree</li>
      <li><code>state:awaiting</code> only that status</li>
      <li><code>replies&gt;0</code> more than none</li>
      <li><code>"repeated words"</code> that exact phrase</li>
      <li><code>typo v&gt;1 tree:bpf</code> all three at once</li>
    </ul>
    <p class="muted">Fields here: ${fields.map((f) => `<code>${esc(f)}</code>`).join(" ")}</p>
    <button class="btn ghost sm" ${act(gridMenu, id, "")}>Done</button>
  </div>`;
}

function pager(id, page, pages, total, start, shown) {
  const nums = [];
  const push = (n) => nums.push(
    `<button class="${n === page ? "on" : ""}" ${act(gridPage, id, n)}>${n}</button>`);
  if (pages <= 7) { for (let i = 1; i <= pages; i++) push(i); }
  else {
    push(1);
    const lo = Math.max(2, page - 1), hi = Math.min(pages - 1, page + 1);
    if (lo > 2) nums.push(`<span class="gap">\u2026</span>`);
    for (let i = lo; i <= hi; i++) push(i);
    if (hi < pages - 1) nums.push(`<span class="gap">\u2026</span>`);
    push(pages);
  }
  return `<div class="pager">
    <button ${act(gridPage, id, page - 1)} ${page <= 1 ? "disabled" : ""}>\u2039</button>
    ${nums.join("")}
    <button ${act(gridPage, id, page + 1)} ${page >= pages ? "disabled" : ""}>\u203A</button>
    <div class="spacer"></div>
    <select ${actv("change", gridPer, id)} title="Rows per page">
      ${[10, 25, 50, 100, 250].map((n) => `<option ${
        GRIDS[id].per === n ? "selected" : ""}>${n}</option>`).join("")}
    </select>
    <span class="info">${total ? `${start + 1}\u2013${start + shown} of ${total}`
                               : "nothing to show"}</span>
  </div>`;
}

/* Redrawing only the grid keeps the rest of the page still, which is what
   makes the row animation readable. */
function gridRedraw(id) {
  gridSave(id);
  const el = document.querySelector(`[data-grid="${id}"]`);
  const box = el && el.closest(".content");
  if (!el) { render(); return; }
  flip(box || document.body, "tbody tr[data-rk]", () => render(id));
}

function gridSearch(id, v) { GRIDS[id].q = v; GRIDS[id].page = 1; gridRedraw(id); }
function gridPage(id, n) { GRIDS[id].page = n; gridRedraw(id); }
function gridPer(id, n) { GRIDS[id].per = +n; GRIDS[id].page = 1; gridRedraw(id); }
function gridFilter(id, k, v) { GRIDS[id].filters[k] = v; GRIDS[id].page = 1; gridRedraw(id); }
function gridGroup(id, k) { GRIDS[id].group = k; GRIDS[id].collapsed = []; gridRedraw(id); }
function gridDense(id) { GRIDS[id].dense = !GRIDS[id].dense; gridRedraw(id); }
function gridMenu(id, which) { GRIDS[id].menu = GRIDS[id].menu === which ? "" : which; gridRedraw(id); }
function gridHelp(id) { gridMenu(id, "help"); }

function gridClear(id) {
  const s = GRIDS[id];
  s.q = ""; s.filters = {}; s.page = 1;
  gridRedraw(id);
}

function gridColumn(id, key, on) {
  const s = GRIDS[id];
  s.hidden = on ? s.hidden.filter((k) => k !== key) : s.hidden.concat(key);
  gridRedraw(id);
}

function gridToggleGroup(id, name) {
  const s = GRIDS[id];
  s.collapsed = s.collapsed.includes(name)
    ? s.collapsed.filter((n) => n !== name) : s.collapsed.concat(name);
  gridRedraw(id);
}

/* Shift-click adds a second and third sort rather than replacing the first,
   which is how you ask for "newest, but group the tree together". */
function gridSort(id, key, el, ev) {
  const s = GRIDS[id];
  const at = s.sorts.findIndex((x) => x.key === key);
  if (ev && ev.shiftKey) {
    if (at >= 0) s.sorts[at].dir = s.sorts[at].dir === "asc" ? "desc" : "asc";
    else s.sorts.push({ key, dir: "desc" });
  } else if (at === 0 && s.sorts.length === 1) {
    s.sorts = [{ key, dir: s.sorts[0].dir === "asc" ? "desc" : "asc" }];
  } else {
    s.sorts = [{ key, dir: "desc" }];
  }
  gridRedraw(id);
}

function gridCsv(id, rows, cols, opts) {
  const st = GRIDS[id];
  const parsed = parseQuery(st.q);
  let data = rows.filter((r) => matchQuery(r, parsed, opts));
  for (const [k, v] of Object.entries(st.filters)) {
    if (!v) continue;
    const f = (opts.filters || []).find((x) => x.key === k);
    if (f) data = data.filter((r) => f.match(r, v));
  }
  const use = cols.filter((c) => c.label && !st.hidden.includes(c.key));
  const cell = (c, r) => {
    const v = c.csv ? c.csv(r) : (c.sort ? c.sort(r) : r[c.key]);
    return `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
  };
  const csv = [use.map((c) => `"${c.label}"`).join(",")]
    .concat(data.map((r) => use.map((c) => cell(c, r)).join(","))).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `mainline-${id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Saved ${plural(data.length, "row")} as CSV.`, "ok");
}
