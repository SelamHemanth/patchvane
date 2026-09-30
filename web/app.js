/* Patchvane -- upstream patch tracker.
   Views and data.  The engine underneath is in ui.js. */

const S = {
  data: null,
  view: "overview",
  busy: false,
  offline: false,
  status: {},
  tabs: {},
  chat: [],
  /* The patch being read in full, if any. */
  thread: null,
  /* Whose chat this is.  A conversation is about one person's patches and
     often quotes their reviewers, so it must not outlive their session. */
  chatWho: "",
  asking: false,
  /* The conversation on screen, as the server knows it.  Empty until the
     first answer, because a conversation with nothing in it is not one. */
  chatId: "",
  chats: [],
  histOpen: false,
  /* The Support tab: what was searched for, what is open, and what is being
     written. */
  support: {},
  /* Which explanations have been unfolded.  Kept for the session only: the
     question "what is this panel" is asked once and then not again. */
  info: {},
  /* Everything everybody sent, for whoever runs this deployment. */
  inbox: [],
  inboxAsked: false,
  inboxPick: "",
  answer: {},
};

/* ------------------------------------------------------------- constants */

const STATES = {
  "merged":            { label: "In mainline",        cls: "green",  rank: 0 },
  "in-next":           { label: "In linux-next",      cls: "cyan",   rank: 1 },
  "in-tree":           { label: "In maintainer tree", cls: "cyan",   rank: 2 },
  "accepted":          { label: "Accepted",           cls: "green",  rank: 3 },
  "queued":            { label: "Queued",             cls: "cyan",   rank: 4 },
  "awaiting-upstream": { label: "Awaiting upstream",  cls: "cyan",   rank: 5 },
  "reviewed":          { label: "Reviewed",           cls: "blue",   rank: 6 },
  "under-review":      { label: "In discussion",      cls: "amber",  rank: 7 },
  "needs-ack":         { label: "Needs ack",          cls: "amber",  rank: 8 },
  "awaiting":          { label: "No reply yet",       cls: "grey",   rank: 9 },
  "changes-requested": { label: "Changes requested",  cls: "purple", rank: 10 },
  "superseded":        { label: "Superseded",         cls: "grey",   rank: 11 },
  "not-applicable":    { label: "Not applicable",     cls: "red",    rank: 12 },
  "handled-elsewhere": { label: "Handled elsewhere",  cls: "grey",   rank: 13 },
  "deferred":          { label: "Deferred",           cls: "grey",   rank: 14 },
  "rejected":          { label: "Rejected",           cls: "red",    rank: 15 },
};

const C = {
  green: "#3fb950", blue: "#4c8dff", amber: "#e3a008",
  purple: "#a371f7", red: "#f85149", cyan: "#2dd4bf", grey: "#7d8590",
};

const PALETTE = ["#4c8dff", "#3fb950", "#e3a008", "#a371f7", "#f85149",
                 "#2dd4bf", "#db61a2", "#e3b341", "#7d8590", "#58a6ff"];

const NAV = [
  ["overview",    "Overview",    "\u25F0"],
  ["owed",        "Your turn",   "\u2691"],
  ["patches",     "Patches",     "\u2261"],
  ["outcomes",    "Outcomes",    "\u2713"],
  ["discussions", "Discussions", "\u2709"],
  ["insights",    "Insights",    "\u2197"],
  ["discover",    "Discover",    "\u2315"],
];

/* What is in the sidebar depends on who is looking at it.  Everything
   above is somebody's own patches; the section below is the deployment
   itself, and only the person running it has one.

   It is here rather than folded into Settings because it is not a setting.
   Reports arrive while you are using the dashboard, they are addressed to
   you, and they need answering -- which makes them work, like the patches
   above, and work belongs where the eye already goes.  Being a section
   also means the count of what is waiting is visible from every page
   without opening anything. */
function navList() {
  return (S.support || {}).owner
    ? NAV.concat([["inbox", "Feedback", "\u270E"]])
    : NAV;
}

/* Terminal states: the patch has stopped moving, one way or another. */
const CLOSED = ["superseded", "rejected", "not-applicable", "handled-elsewhere",
                "deferred"];
const LANDED = ["merged", "in-next", "in-tree", "accepted", "queued",
                "awaiting-upstream"];

/* Where every patch stands.  One bucket each, no patch in two, and between
   them they have to cover all of STATES: the whole point is that the total
   adds back up to the number of patches posted.  A state nobody thought of
   lands in "unaccounted" and shows up on screen rather than quietly
   disappearing from the arithmetic. */
const LEDGER = [
  { key: "mainline", label: "In mainline", cls: "green", color: C.green,
    blurb: "the commit is in Linus' tree",
    states: ["merged"] },
  { key: "onway", label: "Accepted, on the way", cls: "cyan", color: C.cyan,
    blurb: "a maintainer took it; heading for a merge window",
    states: ["in-next", "in-tree", "accepted", "queued", "awaiting-upstream"] },
  { key: "review", label: "Being reviewed", cls: "amber", color: C.amber,
    blurb: "someone is looking at it, or has already tagged it",
    states: ["reviewed", "under-review", "needs-ack"] },
  /* A state, not a verdict. Whether a v2 is actually owed is a question
     about the thread, and Your turn answers it there. */
  { key: "respin", label: "Changes requested", cls: "purple", color: C.purple,
    blurb: "somebody asked for changes to this posting",
    states: ["changes-requested"] },
  { key: "quiet", label: "No reply yet", cls: "grey", color: C.grey,
    blurb: "posted, and nobody has said anything",
    states: ["awaiting"] },
  { key: "dropped", label: "Dropped", cls: "red", color: C.red,
    blurb: "superseded, rejected, or picked up somewhere else",
    states: CLOSED },
];

const BUCKET_OF = (() => {
  const m = {};
  LEDGER.forEach((b) => b.states.forEach((s) => { m[s] = b.key; }));
  return m;
})();

function bucketOf(patch) { return BUCKET_OF[patch.state] || "unaccounted"; }

/* One row per patch, not one per mail.

   A patch sent as v1 and again as v2 is two postings, and the collected
   data keeps both, which is right: the history is worth having. Counting
   both is not. It said 428 patches where 257 had been written, filed the
   abandoned v1 under Dropped while v2 sat in mainline, and left every
   total on the page disagreeing with every other one.

   So one version speaks for each patch: the one that landed if any did,
   and otherwise the newest sent. Everything counted anywhere on this page
   is counted over that set. The versions behind it are not lost -- they
   are on the row that speaks, and the patch opens on all of them. */
function roster(patches) {
  const by = new Map();
  for (const p of patches || []) {
    const k = p.key || p.msgid || p.subject;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p);
  }
  const out = [];
  for (const rows of by.values()) {
    const sorted = rows.slice().sort(
      (a, b) => (a.version || 1) - (b.version || 1)
             || String(a.date || "").localeCompare(String(b.date || "")));
    const newest = sorted[sorted.length - 1];
    /* The collection gives the commit to exactly one posting, so there is
       at most one of these. */
    const took = sorted.filter((p) => (p.landed || []).length).pop();

    /* Usually the version that landed is the last one sent and there is
       nothing to choose between. When it is not -- a maintainer took v1
       and a v3 went out afterwards -- the landing is a fact about the
       patch rather than about that one posting, so it travels to the row
       that speaks instead of taking the row with it. Letting the older
       posting speak instead put the wrong version and the wrong date on
       a patch somebody had sent again three days ago. */
    let speaks = newest;
    if (took && took !== newest) {
      speaks = Object.assign({}, newest, {
        landed: took.landed,
        state: took.state,
        state_detail: took.state_detail,
        tree_hint: newest.tree_hint || took.tree_hint,
      });
    }
    out.push(sorted.length > 1
      ? Object.assign({}, speaks, { sent: sorted.length })
      : speaks);
  }
  return out.sort((a, b) => String(b.date || "").localeCompare(a.date || ""));
}

/* How many series the patches that speak for themselves belong to.  Every
   resend opens a new series on lore, so the raw count says 24 where 14
   patches were written, which reads like an error next to them. */
function seriesCount() {
  return new Set(work().map((p) => p.series).filter(Boolean)).size;
}

/* Worked out once per collection rather than per view, so no two panels can
   be looking at different sets. */
function work() {
  if (!S.roster || S.roster.of !== S.data) {
    S.roster = { of: S.data, rows: roster((S.data || {}).patches || []) };
  }
  return S.roster.rows;
}

/* How far a patch actually got. The stages are cumulative -- anything in
   mainline also reached linux-next -- so this is the furthest rung it
   climbed, and the road to mainline is drawn from it. */
const ROAD = [
  { key: "posted", label: "Written and sent", color: C.blue,
    blurb: "posted to a kernel list" },
  /* The counts are cumulative, so each label has to be true of everything
     at this rung and every rung above it. "Somebody answered" was not: a
     quiet maintainer applies a typo fix without saying anything, and every
     one of those was being counted as a reply nobody ever wrote. */
  { key: "answered", label: "Somebody acted on it", color: C.amber,
    blurb: "a person replied, or a maintainer just applied it" },
  { key: "taken", label: "A maintainer took it", color: C.purple,
    blurb: "applied to a tree, or marked accepted" },
  { key: "next", label: "Reached linux-next", color: C.cyan,
    blurb: "queued for a merge window, mainline included" },
  { key: "mainline", label: "In mainline", color: C.green,
    blurb: "the commit is in Linus' tree" },
];

const ANSWERED = ["reviewed", "under-review", "needs-ack", "changes-requested"];

function reached(p) {
  if (p.state === "merged" || p.in_mainline) return 4;
  if (p.state === "in-next" || p.in_next) return 3;
  if (LANDED.includes(p.state) || (p.landed || []).length) return 2;
  // A robot build report is not somebody answering, so the rung asks for
  // a human reply. Older data carries no such count; fall back to the
  // named reviewers, which have never included bots.
  const said = p.human_replies !== undefined
    ? p.human_replies : (p.reviewers || []).length;
  if (said > 0 || ANSWERED.includes(p.state)) return 1;
  return 0;
}

/* A patch that stopped for good, rather than one that is merely still
   waiting. Superseded is not here: after roster() the version that was
   replaced is not the one speaking, so nothing is dropped for having been
   improved. */
function closed(p) { return CLOSED.includes(p.state); }

/* The ledger for a set of patches, plus whatever failed to classify. */
function ledger(patches) {
  const count = {};
  LEDGER.forEach((b) => { count[b.key] = 0; });
  let loose = [];
  patches.forEach((p) => {
    const k = bucketOf(p);
    if (k === "unaccounted") loose.push(p);
    else count[k]++;
  });
  const rows = LEDGER.map((b) => Object.assign({}, b, { value: count[b.key] }));
  if (loose.length) {
    rows.push({ key: "unaccounted", label: "Unaccounted", cls: "red",
      color: C.red, value: loose.length,
      blurb: "states this dashboard does not know about: "
             + [...new Set(loose.map((p) => p.state))].join(", ") });
  }
  return rows;
}

const SUGGESTIONS = [
  "What needs my attention today?",
  "Which series are stuck and why?",
  "Summarise the review feedback I have received.",
  "Which trees have accepted the most of my work?",
  "What should I do next to get more patches into mainline?",
];

/* --------------------------------------------------------------- domain */

function state(name) {
  return STATES[name] || { label: name || "unknown", cls: "grey", rank: 20 };
}

function pill(name) {
  const s = state(name);
  return `<span class="pill ${s.cls}">${esc(s.label)}</span>`;
}

/* Subsystem is the first component of the subject prefix, which is what the
   kernel uses: "net: cortina: fix ..." belongs to net. */
function subsystem(subject) {
  const m = /^([^:]{1,40}):/.exec(subject || "");
  if (!m) return "other";
  let p = m[1].trim();
  if (p.includes(" ")) p = p.split(" ")[0];
  return p.split("/")[0].toLowerCase() || "other";
}

function treeOf(r) { return r.tree_hint || r.list || "unspecified"; }

/* Explanation, folded away until it is wanted.

   A paragraph telling you what a panel means is worth having the first
   time and is clutter every time after, and there is no way to tell which
   visit this is. So it lives behind the mark beside the heading: nothing
   is lost, and the screen is the numbers rather than the prose about the
   numbers. Open ones are remembered for the session. */
function info(id, html, mark) {
  const on = !!S.info[id];
  return `<button class="infomark ${on ? "on" : ""}" ${act(toggleInfo, id)}
    aria-expanded="${on}" title="${on ? "Hide" : "What is this?"}"
    >${mark || "i"}</button>${on ? `<div class="infobody">${html}</div>` : ""}`;
}

function toggleInfo(id) {
  if (S.info[id]) delete S.info[id];
  else S.info[id] = true;
  render();
}

function link(url, label) {
  if (!url) return `<span class="muted">\u2014</span>`;
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${label || "lore \u2197"}</a>`;
}

/* ------------------------------------------------------- grid definitions */

/* Filters on the ledger bucket as well as the exact state, so "Dropped" and
   "Rejected" are both reachable and mean different things. */
/* Read out of the thread by a model rather than taken from a commit or a
   patchwork state.  Worth saying so: it is a good guess, not a fact. */
function byAI(r) {
  return r.state_by_ai
    ? ` <span class="readmark" title="A model read this status out of the replies. It is a reading, not a record.">read</span>`
    : "";
}

/* The options for one dropdown, with how many rows each would leave.

   Every column worth grouping by is worth filtering by, and the count
   beside each option is the point: it says what pressing it will do before
   it is pressed, and an option that would leave nothing is not offered at
   all. Ordered by how common the value is unless the caller knows better.
   Used by every filter on the site, so they all behave the same way. */
function countedValues(rows, of, label, order) {
  const c = {};
  rows.forEach((r) => {
    const k = of(r);
    if (k === "" || k === null || k === undefined) return;
    c[k] = (c[k] || 0) + 1;
  });
  const keys = Object.keys(c);
  keys.sort(order ? order : (a, b) => c[b] - c[a] || a.localeCompare(b));
  return keys.map((k) => ({ value: k,
                            label: `${label ? label(k) : k} (${c[k]})` }));
}

/* A dropdown built straight from a column, for the columns that need
   nothing cleverer than their own values. */
function byColumn(key, all, of, label) {
  return { key, all, values: (rows) => countedValues(rows, of, label),
           match: (r, v) => String(of(r)) === v };
}

function stateFilter() {
  return {
    key: "state", all: "Any status",
    values: (rows) => {
      const buckets = {}, exact = {};
      rows.forEach((r) => {
        buckets[bucketOf(r)] = (buckets[bucketOf(r)] || 0) + 1;
        exact[r.state] = (exact[r.state] || 0) + 1;
      });
      return LEDGER.filter((b) => buckets[b.key])
        .map((b) => ({ value: "~" + b.key,
                       label: `${b.label} (${buckets[b.key]})` }))
        .concat(Object.keys(exact)
          .sort((a, b) => state(a).rank - state(b).rank)
          .map((k) => ({ value: k, label: `\u00a0\u00a0${state(k).label} (${exact[k]})` })));
    },
    match: (r, v) => (v.charAt(0) === "~" ? bucketOf(r) === v.slice(1)
                                          : r.state === v),
  };
}

function treeFilter() {
  return byColumn("tree", "Any tree", treeOf);
}

function subsystemFilter() {
  return byColumn("sub", "Any subsystem", (r) => subsystem(r.subject),
                  (k) => k + "/");
}

/* The road, as a filter, so a stage clicked on the overview lands on
   exactly the patches it counted.  "taken" is everything that got at least
   that far; "here:taken" is what is sitting there; "lost:taken" is what
   stopped there. */
function roadFilter() {
  return {
    key: "road", all: "Any stage",
    values: (rows) => {
      const far = rows.map(reached);
      const out = [];
      ROAD.forEach((s, i) => {
        const through = far.filter((n) => n >= i).length;
        if (through) out.push({ value: s.key, label: `${s.label} (${through})` });
        const lost = rows.filter((p, n) => far[n] === i && closed(p)).length;
        if (lost) {
          out.push({ value: "lost:" + s.key,
                     label: `\u00a0\u00a0dropped at ${s.label} (${lost})` });
        }
      });
      return out;
    },
    match: (r, v) => {
      const part = v.includes(":") ? v.split(":")[0] : "";
      const at = ROAD.findIndex((s) => s.key === v.split(":").pop());
      if (at < 0) return true;
      const got = reached(r);
      if (part === "lost") return got === at && closed(r);
      if (part === "here") return got === at && !closed(r);
      return got >= at;
    },
  };
}

const PATCH_FIELDS = {
  road: (r) => ROAD[reached(r)].key,
  tree: (r) => treeOf(r),
  state: (r) => r.state,
  status: (r) => state(r.state).label,
  sub: (r) => subsystem(r.subject),
  subsystem: (r) => subsystem(r.subject),
  v: (r) => r.version,
  version: (r) => r.version,
  replies: (r) => r.reply_count,
  date: (r) => (r.date || "").slice(0, 10),
  series: (r) => r.series_name,
};

function patchColumns() {
  return [
    { key: "subject", label: "Patch", cls: "subject", width: "44%",
      csv: (r) => r.subject,
      render: (r) => `${subj(r.msgid || r.series, r.subject)}
        ${r.version > 1 ? `<span class="tag">v${r.version}</span>` : ""}
        <div class="sub2">${mark(r.state_detail)}${byAI(r)}</div>` },
    { key: "tree", label: "Tree", sort: treeOf,
      render: (r) => `<span class="nowrap muted">${mark(treeOf(r))}</span>` },
    { key: "state", label: "Status", sort: (r) => state(r.state).rank,
      csv: (r) => state(r.state).label, render: (r) => pill(r.state) },
    { key: "date", label: "Posted", csv: (r) => (r.date || "").slice(0, 10),
      render: (r) => `<span class="nowrap muted">${ago(r.date)}</span>` },
    { key: "reply_count", label: "Replies", cls: "num",
      render: (r) => r.reply_count || `<span class="muted">0</span>` },
    { key: "links", label: "Links", sortable: false, cls: "nowrap links",
      csv: (r) => r.lore,
      render: (r) => [
        link(r.lore, "lore"),
        r.pw_url ? `<a href="${esc(r.pw_url)}" target="_blank" rel="noreferrer">pw</a>` : "",
        r.landed[0] ? sha(landedIn(r.landed)) : "",
      ].filter(Boolean).join(" ") },
  ];
}

function patchGridOpts(extra) {
  return Object.assign({
    placeholder: "Search, or try tree:net-next state:awaiting v>1\u2026",
    searchIn: (r) => [r.subject, r.tree_hint, r.list, r.state, r.series_name,
                      r.pw_project, r.state_detail].join(" "),
    fields: PATCH_FIELDS,
    filters: [stateFilter(), roadFilter(), subsystemFilter(), treeFilter()],
    groups: [{ key: "tree", label: "by tree", of: treeOf },
             { key: "state", label: "by status", of: (r) => state(r.state).label },
             { key: "road", label: "by stage", of: (r) => ROAD[reached(r)].label },
             { key: "sub", label: "by subsystem", of: (r) => subsystem(r.subject) + "/" }],
    rowKey: (r) => r.msgid || r.lore || r.subject,
    sort: "date", dir: "desc", per: 25,
  }, extra || {});
}

/* The road, stage by stage, over one row per patch.

   Each stage says three things, because the three are different questions
   and the old funnel only answered the first: how many got this far, how
   many are sitting here now, and how many stopped here for good. The last
   is the one that was missing -- a patch that was discussed and then
   abandoned used to vanish into a single "Dropped" total at the bottom of
   the page, with nothing to say at which point it was lost. */
function road() {
  const rows = work();
  const far = rows.map(reached);
  return ROAD.map((s, i) => {
    const here = rows.filter((p, n) => far[n] === i);
    return Object.assign({}, s, {
      i,
      through: far.filter((n) => n >= i).length,
      resting: here.filter((p) => !closed(p)).length,
      lost: here.filter(closed).length,
      lostRows: here.filter(closed),
    });
  });
}

/* ----------------------------------------------------------------- views */

function viewOverview() {
  const d = S.data, k = d.kpis;
  const attention = conversations().filter((t) => t.waiting_on_us);
  const book = ledger(work());

  const tl = d.timeline.slice(-45);
  const chart = chartSlot("ov-time", 168, (w, h) => lineChart(
    tl.map((t) => t.date.slice(5)), [
      { name: "Posted", color: C.blue, points: tl.map((t) => t.sent), fill: true },
      { name: "Landed", color: C.green, points: tl.map((t) => t.merged) },
    ], w, h));

  const attentionList = attention.slice(0, 5).map((t, i) => `
    <div class="attn" data-reveal style="--i:${i}">
      <div class="who">${esc(t.last_from)}<span class="when">${ago(t.last_date)}</span></div>
      ${subj(t.id, t.series, "sj")}
      <p>${esc(t.excerpt)}</p>
    </div>`).join("") || `<div class="empty"><div class="emptyicon">\u2713</div>
      <p>Your inbox is clear. Nothing on the list needs an answer.</p></div>`;

  const feed = d.activity.slice(0, 7).map(feedItem).join("");

  /* A step that fails is recorded and the run carries on, so a collection
     that could not read a single message still writes a file and still
     arrives here as a confident zero. Say which part failed and why,
     rather than letting the page report that you have posted nothing. */
  const SOURCE = {
    lore: ["Reading the mailing lists", "lore.kernel.org"],
    patchwork: ["Checking patchwork", "patchwork.kernel.org"],
    korg: ["Looking through the trees", "git.kernel.org"],
  };
  /* What to say about each kind of failure.  Never the exception text: it
     names libraries and files that mean nothing to somebody who opened a
     dashboard, and reads like something broke in the page rather than
     something being in the way of it. The exact reason is in the server's
     own log, where whoever runs it can act on it. */
  const TROUBLE = {
    untrusted: "Something on this network is inspecting secure connections, "
      + "and this computer has not been set up to trust it, so the archives "
      + "cannot be read. On a company network the IT team will know what to "
      + "install; on your own, connecting another way will avoid it.",
    tls: "The secure connection to the archives could not be established.",
    dns: "The archives could not be looked up, which usually means this "
      + "computer has no working network connection.",
    timeout: "The archives did not answer in time. They may be busy, or "
      + "this connection may be very slow.",
    refused: "The connection to the archives was closed before anything "
      + "could be read.",
    blocked: "This network turned the request away before it reached the "
      + "archives.",
    offline: "This computer could not reach the archives.",
  };
  const src = d.sources || {};
  const broke = Object.keys(SOURCE).filter(
    (n) => src[n] && src[n].ok === false && src[n].error !== "skipped");
  const missed = (src.cache || {}).errors || 0;
  /* A collection from before the codes existed has none, so fall back to
     saying only what is certainly true. */
  const why = TROUBLE[(broke.length && src[broke[0]].code) || ""]
    || "The archives could not be read from this computer.";

  const shortfall = !broke.length && !missed ? "" : `
  <div class="panel warn" data-reveal><div class="body">
    ${broke.length ? `<strong>${broke.map((n) => SOURCE[n][0]).join(", ")}
      did not work last time.</strong> ${why}`
      : `<strong>${plural(missed, "request")} to the archives did not come
         back.</strong>`}
    ${work().length
      ? " Some of what is below may be missing or out of date."
      : " That is why there is nothing below: this is what could be read, "
        + "not an answer about your patches."}
    <span class="muted"> Once the connection works, refresh to collect
    again.</span>
  </div></div>`;

  return `
  ${shortfall}
  ${cyclePanel()}
  ${roadPanel()}
  ${stalePanel()}
  ${ledgerPanel(book, work().length)}

  <div class="split">
    <div class="stack">
      <div class="panel" data-reveal>
        <header><h2>Needs a reply from you</h2>
          <div class="spacer"></div>
          ${attention.length ? `<span class="pill amber">${attention.length}</span>` : ""}
          <button class="link" ${act(go, "discussions")}>All threads</button></header>
        <div class="body flush attnlist">${attentionList}</div>
      </div>
      <div class="panel" data-reveal>
        <header><h2>Last six weeks</h2><div class="spacer"></div>
          <div class="chartlegend">
            <span><i style="background:${C.blue}"></i>posted</span>
            <span><i style="background:${C.green}"></i>landed</span>
          </div></header>
        <div class="body">${chart}</div>
      </div>
    </div>
    <div class="rail">
      <div class="panel" data-reveal>
        <header><h2>Latest activity</h2><div class="spacer"></div>
          <button class="link" ${act(go, "discussions")}>More</button></header>
        <div class="feed">${feed}</div>
      </div>
    </div>
  </div>`;
}

/* The funnel above is a flow: a patch counted at "accepted" was also counted
   at "posted".  This is the opposite, and the one that has to balance.  Each
   patch appears exactly once, and the sum is stated on screen so a bucket
   that stops adding up is visible rather than merely wrong. */
/* The road, drawn. Each stage is a button that lands on the patches behind
   it, and each stage that lost something says so and opens those instead,
   so "dropped" is answerable at the point it happened rather than as one
   number at the bottom of the page. */
/* Where the kernel is in its own cycle, and what that means for the patches
   on this page.

   Nothing else here is about the tree rather than the person, but this is
   what decides how to read everything else.  A patch that has sat unanswered
   for a fortnight is a worry at -rc5 and is simply the calendar during the
   merge window, when maintainers are sending pull requests to Linus and not
   reading the list.  Told the date and left to work that out, nobody does. */
/* Which piece of news this is. The phase and the tag together, so that a
   new -rc, or the window opening, is a fresh notice and shows again rather
   than staying hidden behind a dismissal of the last one. */
function cycleNews(c) { return (c.phase || "") + ":" + (c.tag || ""); }

/* Shown once a session and then only if asked for, because it says the same
   thing all week. Dismissing it puts it away until the tree moves on.

   Whether it has already been seen is read once per page load: marking it
   seen on every render would have it vanish under the reader the moment
   anything else on the page redrew. */
let CYCLE_SHOWING = null;

function cycleHidden(c) {
  const news = cycleNews(c);
  if (CYCLE_SHOWING === news) return false;
  try {
    if (localStorage.getItem("patchvane-cycle-dismissed") === news) return true;
    if (sessionStorage.getItem("patchvane-cycle-seen") === news) return true;
    sessionStorage.setItem("patchvane-cycle-seen", news);
  } catch (e) { /* private browsing: show it, that is the harmless way */ }
  CYCLE_SHOWING = news;
  return false;
}

function cycleDismiss() {
  const c = (S.data || {}).cycle;
  if (!c) return;
  try {
    localStorage.setItem("patchvane-cycle-dismissed", cycleNews(c));
  } catch (e) { /* nothing to do: it goes for this page load either way */ }
  CYCLE_SHOWING = null;
  const el = document.querySelector(".panel.cycle");
  if (el) el.remove();
}

function cyclePanel() {
  const c = S.data.cycle;
  if (!c || !c.phase) return "";
  if (cycleHidden(c)) return "";
  const window = c.phase === "merge-window";
  const opens = days(c.opens);
  /* Counted off the patches, not off the commit list, so this agrees with
     the "sitting here" figure on the road below. The two differ whenever a
     maintainer took an earlier version: the commit is filed under the
     posting that landed, while the patch is counted at the version that
     speaks for it. */
  const queued = work().filter((p) => reached(p) === 3).length;

  let head, note;
  if (window) {
    head = `The ${esc(c.next)} merge window is open.`;
    note = `Maintainers are sending pull requests to Linus, not reading the
      list. Quiet on anything you posted is the calendar, not a snub, and a
      ping now lands in the worst possible week. It shuts
      ${when(c.closes)}${c.estimated ? " or thereabouts" : ""}.`;
  } else {
    head = `${esc(c.tag)}. The merge window is shut.`;
    note = `${esc(c.version)} is being stabilised, so maintainers are taking
      fixes for it and queueing everything else for ${esc(c.next)}. Review is
      running normally: silence on a patch this week is worth chasing.`;
  }

  /* What their own work is waiting for, in the same breath.  The count is
     the whole point -- "the merge window opens on the 18th" is trivia until
     it is 109 of your own commits moving. */
  const mine = queued
    ? `${plural(queued, "commit")} of yours ${queued === 1 ? "is" : "are"}
       sitting in linux-next. ${queued === 1 ? "It reaches" : "They reach"}
       mainline when the ${esc(c.next)} merge window opens${
         window ? " \u2014 which is now" : `, ${when(c.opens)}`}.`
    : "";

  return `<div class="panel wide cycle ${window ? "open" : "shut"}" data-reveal>
    <div class="body">
      <div class="cyrow">
        <span class="cymark" aria-hidden="true"></span>
        <div class="cytx">
          <h2>${head}</h2>
          <p>${note}</p>
          ${mine ? `<p class="cymine">${mine}</p>` : ""}
        </div>
        ${!window && opens !== null ? `<div class="cycount">
          <b>${opens}</b><i>days until <br>${esc(c.next)} opens</i></div>` : ""}
        <button class="cyshut" ${act(cycleDismiss)}
          title="Put this away until the tree moves on"
          aria-label="Dismiss this notice">&times;</button>
      </div>
    </div>
  </div>`;
}

/* Whole days from today to a yyyy-mm-dd, or null if it is not one. */
function days(iso) {
  if (!iso) return null;
  const then = Date.parse(iso + "T00:00:00Z");
  if (isNaN(then)) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((then - today) / 86400000);
}

/* "on 18 October", or "next week" when that is the more useful of the two. */
function when(iso) {
  const n = days(iso);
  if (n === null) return "";
  if (n <= 0) return "any day now";
  if (n <= 10) return `in ${plural(n, "day")}`;
  return "on " + new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, {
    day: "numeric", month: "long", timeZone: "UTC" });
}

function roadPanel() {
  const stages = road();
  const top = stages[0].through || 1;
  const anyLost = stages.some((s) => s.lost);

  const steps = stages.map((s) => `
    <div class="step ${s.through ? "" : "nil"}" style="--i:${s.i};
         --tint:${s.color}; --w:${Math.round((s.through / top) * 100)}%">
      <button class="stepface" ${act(showStage, s.key)}
              title="Every patch that got at least this far">
        <span class="stepbar"><i></i></span>
        <span class="stepn">${counter(s.through, "road-" + s.key)}</span>
        <span class="stepname">${esc(s.label)}</span>
        <span class="stepblurb">${esc(s.blurb)}</span>
        <span class="steppc">${pct(s.through, top)} of everything written</span>
      </button>
      <div class="steptail">
        ${s.resting ? `<button class="resting" ${act(showStage, s.key, "here")}
          title="Got this far and no further, and has not been dropped">
          <span class="dot"></span>${s.resting} sitting here</button>` : ""}
        ${s.lost ? `<button class="binbtn" ${act(showStage, s.key, "lost")}
          title="Reached this stage and then stopped for good">
          ${BIN}<span>${s.lost} dropped</span></button>` : ""}
      </div>
    </div>`).join("");

  return `<div class="panel wide road" data-reveal>
    <header><h2>The road to mainline</h2>
      <span class="sub">every patch counted once, at the version that
        speaks for it</span>
      <div class="spacer"></div>
      ${info("road", `Each stage counts the patches that got <em>at least</em>
        that far, so the numbers narrow from left to right. Under each one:
        how many are sitting at that stage now, and how many reached it and
        then stopped for good. A patch you improved is not dropped &mdash;
        the v2 speaks for it, and the v1 is on its record.
        ${anyLost ? "" : "Nothing of yours has been dropped at any stage."}`)}
      <button class="link" ${act(go, "patches")}>See every patch</button>
    </header>
    <div class="body flush"><div class="steps">${steps}</div></div>
  </div>`;
}

const BIN = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"
    fill="none" stroke="currentColor" stroke-width="1.2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M6.6 6.6v5M9.4 6.6v5" fill="none" stroke="currentColor"
    stroke-width="1.2" stroke-linecap="round"/></svg>`;

/* Clicking a stage goes to the patches it counted.  "here" and "lost"
   narrow that to the ones resting at it and the ones that died at it. */
function showStage(key, part) {
  go("patches");
  const st = gridState("patches", patchGridOpts());
  st.q = "";
  st.filters = { road: (part ? part + ":" : "") + key };
  st.page = 1;
  gridSave("patches");
  render();
}

/* When a source could not be reached, the numbers that come from it are the
   ones from before.  Say which, rather than letting them pass as today's. */
function stalePanel() {
  const old = S.data.stale;
  if (!old) return "";
  return `<div class="panel wide warn" data-reveal>
    <div class="body">
      <p class="hint" style="margin:0">Could not reach
      <strong>${old.hosts.map(esc).join(", ")}</strong> on the last collection,
      so ${plural(old.count, "answer")} from an earlier run
      ${old.count === 1 ? "was" : "were"} kept. Which trees have your patches
      may be out of date; everything from the mailing list is current. The next
      refresh will try again.</p>
    </div>
  </div>`;
}

function ledgerPanel(book, total) {
  const sum = book.reduce((a, b) => a + b.value, 0);
  const rows = book.map((b, i) => `
    <button class="ledrow ${b.value ? "" : "nil"}" data-reveal style="--i:${i}"
      ${act(showBucket, b.key)}>
      <span class="sw" style="background:${b.color}"></span>
      <span class="nm">${esc(b.label)}<i>${esc(b.blurb)}</i></span>
      <span class="tr"><i style="width:${(b.value / (total || 1)) * 100}%;
        background:${b.color}"></i></span>
      <span class="vl">${b.value}</span>
      <span class="pc">${pct(b.value, total)}</span>
    </button>`).join("");

  return `<div class="panel wide" data-reveal>
    <header><h2>Where all ${total} patches stand</h2>
      <span class="sub">one bucket each, so it adds up</span>
      <div class="spacer"></div>
      ${info("ledger", `The same patches as the road above, sorted by where
        they stopped rather than by how far they got. Every
        <em>sitting here</em> and <em>dropped</em> count up there lands in
        exactly one bucket down here: the two panels are the same total cut
        two ways, so they add up to ${total} either way.`)}
      <span class="tally ${sum === total ? "ok" : "bad"}">
        ${book.map((b) => b.value).join(" + ")} = ${sum}${
          sum === total ? "" : `, but ${total} were posted`}</span>
    </header>
    <div class="body flush"><div class="ledger">${rows}</div></div>
  </div>`;
}

/* Every bucket is a saved query on the patch list, so clicking one lands on
   the actual patches rather than a dead end. */
function showBucket(key) {
  const b = LEDGER.find((x) => x.key === key);
  go("patches");
  const st = gridState("patches", patchGridOpts());
  st.q = "";
  st.filters = { state: b ? "~" + key : "" };
  st.page = 1;
  gridSave("patches");
  render();
}

/* The feed stores a row as a subject and an address, because that is all
   lore and cgit gave it.  Both open here instead: a merged or queued row
   names a commit in its address, and the rest name a message in a thread
   that belongs to one of these patches, which is enough to find it. */
function feedTarget(a) {
  const hit = (a.url || "").match(/[?&]id=([0-9a-f]{7,40})\b/i);
  if (hit) {
    return act(openCommit, hit[1],
               treeHolding({ trees: (a.note || "").split(/,\s*/) }));
  }
  const id = patchFor(a.text);
  return id ? act(openThread, id, a.text) : "";
}

/* A subject as the feed writes it and the same subject as the patch list
   writes it are rarely the same string: one is a reply, carries a [PATCH
   v3] tag, or counts the series after it. */
function plainSubject(s) {
  return String(s || "")
    .replace(/^(\s*(re|fwd|aw)\s*:\s*)+/i, "")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\s*\(\d+\s+patch(es)?\)\s*$/i, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/* Built on the first row that asks and kept, because every row of the feed
   asks.  Held against the collection it was built from rather than cleared
   by hand, so a fresh collection cannot be read through a stale index. */
function patchFor(text) {
  if (!S.names || S.names.of !== S.data) {
    const by = {};
    const put = (name, id) => {
      const k = plainSubject(name);
      if (k && id && !(k in by)) by[k] = id;
    };
    for (const p of (S.data.patches || [])) {
      const id = p.msgid || p.series;
      put(p.subject, id);
      put(p.raw_subject, id);
      put(p.series_name, id);
      for (const v of (p.versions || [])) put(v.subject, id);
    }
    for (const s of (S.data.series || [])) put(s.name, s.id);
    S.names = { of: S.data, by };
  }
  return S.names.by[plainSubject(text)] || "";
}

function feedItem(a, i) {
  const meta = {
    sent:    { c: "blue",   i: "\u2191", t: "Posted" },
    reply:   { c: "amber",  i: "\u21A9", t: "Reply" },
    applied: { c: "green",  i: "\u2713", t: "Applied" },
    merged:  { c: "green",  i: "\u2713", t: "Merged" },
    queued:  { c: "cyan",   i: "\u21E7", t: "Queued" },
    ci:      { c: "purple", i: "\u2699", t: "CI" },
  }[a.kind] || { c: "grey", i: "\u2022", t: a.kind };
  const col = C[meta.c];
  const open = feedTarget(a);
  /* A bot reporting on somebody else's thread is the one row with nothing
     here to open, so that one keeps a way to read it where it was said. */
  const away = !open && a.url
    ? ` \u00b7 <a href="${esc(a.url)}" target="_blank"
        rel="noreferrer">lore \u2197</a>` : "";
  return `<div class="feeditem" data-reveal style="--i:${i}">
    <div class="ic" style="background:${col}22;color:${col}">${meta.i}</div>
    <div class="tx">
      <div class="t1" style="color:${col}">${esc(meta.t)}</div>
      <div class="t2">${open ? `<a href="#" ${open}>${esc(a.text)}</a>`
        : esc(a.text)}</div>
      <div class="t3">${esc(a.note || "")} \u00b7 ${ago(a.ts)}${away}</div>
    </div></div>`;
}

function viewPatches() {
  const d = S.data, k = d.kpis;
  const rows = work();
  const st = GRIDS["patches"];
  const on = (st && st.filters.state) || "";
  const book = ledger(rows);
  const resent = rows.filter((p) => p.sent > 1).length;

  /* Same buckets as the overview, so a number clicked there and a chip
     pressed here can never disagree. */
  const chips = `<div class="chipbar">`
    + `<button class="chip grey ${on === "" ? "on" : ""}" data-reveal
        ${act(gridFilter, "patches", "state", "")}>Everything<b>${rows.length}</b></button>`
    + book.filter((b) => b.value).map((b, i) => `<button class="chip ${b.cls} ${
        on === "~" + b.key ? "on" : ""}" data-reveal style="--i:${i + 1}"
        title="${esc(b.blurb)}"
        ${act(gridFilter, "patches", "state", "~" + b.key)}
        >${esc(b.label)}<b>${b.value}</b></button>`).join("")
    + `</div>`;

  return grid("patches", rows, patchColumns(), patchGridOpts({
    title: "Every patch you wrote",
    subtitle: `${plural(rows.length, "patch", "patches")} in ${
      plural(seriesCount(), "series", "series")}, since ${day(k.first)}`
      + (resent ? ` \u00b7 ${resent} sent more than once` : ""),
    chips,
  }));
}

function viewOutcomes() {
  const dropped = work().filter(closed);
  return tabs("out", [
    /* Commits, not patches. Fewer of these than patches a maintainer took:
       a patch marked accepted in patchwork has no commit to show yet. The
       tab says which it is so the number is not read against the road. */
    ["landed", `Commits (${S.data.merged.length})`, viewLanded],
    ["dropped", `Dropped (${dropped.length})`, () => viewDropped(dropped)],
  ]);
}

/* The patches that went nowhere.  Worth a page of its own: superseded is
   normal and healthy, rejected is a lesson, and "handled elsewhere" means
   somebody else fixed it first. */
function viewDropped(rows) {
  const why = {
    "superseded": ["A later version replaced it", "grey"],
    "rejected": ["A maintainer said no", "red"],
    "not-applicable": ["Did not apply, or the tree had moved on", "red"],
    "handled-elsewhere": ["Someone else's patch got there first", "grey"],
    "deferred": ["Put off until later", "grey"],
  };
  const counts = {};
  rows.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });

  const cards = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([st, n], i) => `<div class="kpi ${(why[st] || ["", "grey"])[1]} flat"
      data-reveal style="--i:${i}" title="${esc((why[st] || [""])[0])}">
      <div class="label">${esc(state(st).label)}</div>${counter(n, "dr-" + st)}
      <div class="sub">${esc((why[st] || [""])[0])}</div></div>`).join("");

  return `<div class="kpis four">${cards}</div>
    <p class="hint standalone">${plural(rows.length, "patch", "patches")} stopped
    for good. A patch you improved and sent again is not here: the newer
    version speaks for it, and the older one is on its record.</p>`
    + grid("dropped", rows, [
      { key: "subject", label: "Patch", cls: "subject", width: "40%",
        csv: (r) => r.subject,
        render: (r) => `${subj(r.msgid || r.series, r.subject)}${r.version > 1
            ? `<span class="tag">v${r.version}</span>` : ""}` },
      { key: "road", label: "Got as far as", sort: reached,
        csv: (r) => ROAD[reached(r)].label,
        render: (r) => `<span class="pill" style="color:${ROAD[reached(r)].color};
          background:color-mix(in srgb, ${ROAD[reached(r)].color} 16%, transparent)"
          >${esc(ROAD[reached(r)].label)}</span>` },
      { key: "state", label: "What happened", sort: (r) => state(r.state).rank,
        csv: (r) => state(r.state).label, render: (r) => pill(r.state) },
      { key: "state_detail", label: "Why", width: "26%",
        csv: (r) => r.state_detail,
        render: (r) => r.state_detail
          ? `<span class="muted">${mark(r.state_detail)}${byAI(r)}</span>`
          : `<span class="muted">\u2014</span>` },
      { key: "tree", label: "Tree", sort: treeOf,
        render: (r) => `<span class="nowrap muted">${mark(treeOf(r))}</span>` },
      { key: "date", label: "Posted", csv: (r) => (r.date || "").slice(0, 10),
        render: (r) => `<span class="nowrap muted">${ago(r.date)}</span>` },
    ], {
      placeholder: "Search, or try state:rejected tree:net-next\u2026",
      searchIn: (r) => [r.subject, r.state, r.state_detail, treeOf(r)].join(" "),
      fields: PATCH_FIELDS,
      filters: [stateFilter(), roadFilter(), subsystemFilter(), treeFilter()],
      groups: [{ key: "state", label: "by outcome", of: (r) => state(r.state).label },
               { key: "road", label: "by stage", of: (r) => ROAD[reached(r)].label },
               { key: "sub", label: "by subsystem", of: (r) => subsystem(r.subject) + "/" },
               { key: "tree", label: "by tree", of: treeOf }],
      rowKey: (r) => r.msgid || r.lore || r.subject,
      sort: "date", dir: "desc", per: 25,
    });
}

function viewLanded() {
  const d = S.data;
  const rows = d.merged;
  const mainline = rows.filter((r) => r.mainline).length;
  /* Counted off the same one-row-per-patch set as everywhere else, rather
     than off the server's per-posting totals, so these four and the road on
     the overview cannot drift apart. */
  const at = work().map(reached);

  const cards = [
    ["green", "Commits in mainline", mainline],
    ["cyan", "Queued in linux-next", at.filter((n) => n === 3).length],
    ["blue", "In a maintainer tree", at.filter((n) => n === 2).length],
    ["purple", "Still being written or read", at.filter((n) => n <= 1).length],
  ].map(([cls, label, v], i) => `<div class="kpi ${cls} flat" data-reveal style="--i:${i}">
    <div class="label">${esc(label)}</div>${counter(v, "ld-" + label)}</div>`).join("");

  return `<div class="kpis four">${cards}</div>` +
    grid("landed", rows, [
      { key: "short", label: "Commit", cls: "mono nowrap", csv: (r) => r.short,
        render: (r) => sha(r) },
      { key: "subject", label: "Subject", cls: "subject", width: "46%",
        csv: (r) => r.subject,
        render: (r) => csubj(r, r.subject) + (r.versions > 1
          ? `<span class="tag">${r.versions} versions</span>` : "")
          + (r.series && r.series !== r.subject
            ? `<div class="sub2">posted as: ${mark(r.series)}</div>` : "") },
      { key: "where", label: "Where it is", sortable: false,
        csv: (r) => r.trees.join(" "),
        render: (r) => `<div class="chips">` + r.trees.map((t) =>
          `<span class="pill ${t === "mainline" ? "green" : t === "linux-next" ? "cyan" : "blue"}">${esc(t)}</span>`
        ).join("") + `</div>` },
      { key: "date", label: "Landed",
        render: (r) => `<span class="nowrap muted">${esc(r.date)}</span>` },
      { key: "lore", label: "Thread", sortable: false, cls: "links",
        csv: (r) => r.lore, render: (r) => link(r.lore) },
    ], {
      title: "Commits that landed",
      subtitle: `${rows.length} commits, ${mainline} of them already in Linus' tree`,
      placeholder: "Search a commit or a subject\u2026",
      searchIn: (r) => [r.subject, r.short, r.trees.join(" ")].join(" "),
      fields: { tree: (r) => r.trees.join(" "), mainline: (r) => r.mainline,
                date: (r) => r.date, versions: (r) => r.versions || 1,
                sub: (r) => subsystem(r.subject) },
      filters: [
        byColumn("where", "Anywhere", (r) => r.mainline ? "mainline"
          : r.in_next ? "linux-next" : (r.trees[0] || "a maintainer tree")),
        subsystemFilter(),
        byColumn("year", "Any year", (r) => (r.date || "").slice(0, 4)),
      ],
      groups: [{ key: "where", label: "by tree", of: (r) => r.trees[0] || "\u2014" },
               { key: "sub", label: "by subsystem", of: (r) => subsystem(r.subject) + "/" }],
      rowKey: (r) => r.commit || r.short,
      sort: "date", dir: "desc", per: 25,
    });
}

function viewDiscussions() {
  const d = S.data;
  return tabs("disc", [
    ["threads", `Threads (${conversations().length})`, discThreads],
    ["people", `People (${d.people.length})`, discPeople],
    ["tags", `Review tags (${d.tagrows.length})`, discTags],
  ]);
}

/* One row per conversation, the same way the patch list is one row per
   patch.  Posting v1, v2 and v3 opens three threads on lore, and listing
   all three put the same subject on screen five times over, four of them
   ending "Superseded", which is a list of postings rather than of
   conversations. The newest round stands for the discussion and says how
   many came before it. */
function conversations() {
  if (!S.talk || S.talk.of !== S.data) {
    const by = new Map();
    for (const t of (S.data.threads || [])) {
      const k = plainSubject(t.series) || t.id;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    /* A thread carries the status of the posting it belongs to, so the
       last round of a patch that has since reached mainline still reads
       "Superseded" here while the patch list reads "In mainline". They are
       the same patch; they get the same word. */
    const said = new Map();
    for (const p of work()) {
      for (const name of [p.subject, p.series_name, p.raw_subject]) {
        const k = plainSubject(name);
        if (k) said.set(k, p.state);
      }
    }

    const rows = [];
    for (const [k, group] of by) {
      const sorted = group.slice().sort(
        (a, b) => compare(a.last_date, b.last_date));
      const newest = sorted[sorted.length - 1];
      const one = group.length > 1
        ? Object.assign({}, newest, {
            rounds: group.length,
            /* Every message of every round: the conversation is all of it,
               not only what was said about the last version. */
            count: group.reduce((a, t) => a + (t.count || 0), 0),
          })
        : Object.assign({}, newest);
      if (said.has(k)) one.state = said.get(k);
      rows.push(one);
    }
    S.talk = { of: S.data, rows: rows.sort((a, b) => compare(b.last_date, a.last_date)) };
  }
  return S.talk.rows;
}

function discThreads() {
  return grid("threads", conversations(), [
    { key: "series", label: "Thread", cls: "subject", width: "46%",
      csv: (r) => r.series,
      render: (r) => `${subj(r.msgid || r.id || r.series, r.series)}${r.rounds
          ? `<span class="tag">${r.rounds} rounds</span>` : ""}
        <div class="sub2">${mark(r.excerpt)}</div>` },
    { key: "last_from", label: "Last word from", csv: (r) => r.last_from,
      render: (r) => `${mark(r.last_from)}<div class="sub2">${ago(r.last_date)}</div>` },
    { key: "state", label: "Status", sort: (r) => state(r.state).rank,
      csv: (r) => state(r.state).label, render: (r) => pill(r.state) },
    { key: "count", label: "Msgs", cls: "num", render: (r) => r.count },
    { key: "rounds", label: "Rounds", cls: "num", sort: (r) => r.rounds || 1,
      csv: (r) => r.rounds || 1,
      render: (r) => r.rounds || `<span class="muted">1</span>` },
    { key: "waiting_on_us", label: "Action", sort: (r) => (r.waiting_on_us ? 1 : 0),
      csv: (r) => (r.waiting_on_us ? "reply needed" : ""),
      render: (r) => r.waiting_on_us
        ? `<span class="pill amber">reply needed</span>` : `<span class="muted">\u2014</span>` },
    { key: "ai", label: "", sortable: false, cls: "nowrap",
      render: (r) => `<button class="ai-inline" title="Ask the assistant about this thread"
        ${act(askAboutThread, r)}>\u2726</button>` },
  ], {
    title: "Conversations on the lists",
    subtitle: "every thread you started, and what came back",
    placeholder: "Search, or try state:reviewed replies>2\u2026",
    searchIn: (r) => [r.series, r.last_from, r.excerpt, r.tree].join(" "),
    fields: { tree: (r) => r.tree, state: (r) => r.state,
              from: (r) => r.last_from, replies: (r) => r.count,
              waiting: (r) => (r.waiting_on_us ? "yes" : "no") },
    filters: [
      stateFilter(),
      byColumn("waiting", "Anything", (r) => r.waiting_on_us
        ? "waiting on you" : "nothing owed"),
      byColumn("tree", "Any tree", (r) => r.tree || "unspecified"),
      byColumn("from", "Anyone last", (r) => r.last_from || "nobody"),
    ],
    groups: [{ key: "tree", label: "by tree", of: (r) => r.tree || "\u2014" },
             { key: "state", label: "by status", of: (r) => state(r.state).label }],
    rowKey: (r) => r.id || r.series,
    sort: "last_date", dir: "desc", per: 25,
    headerRight: link(S.data.profile.lore, "open lore \u2197"),
  });
}

// A maintainer answers from whatever address they read mail at, which is
// often not the one in MAINTAINERS that the patch was sent to: Takashi
// Iwai is copied at suse.com and replies from suse.de.  So the name is the
// key here and the address is only a fallback, with any +tag cut off.
const samePerson = {
  name: (n) => (n || "").toLowerCase().replace(/[^a-z]/g, ""),
  box: (a) => (a || "").split("@")[0].split("+")[0].toLowerCase(),
};

function askedRows() {
  const by = new Map();
  const get = (w) => {
    const k = samePerson.name(w.name) || w.addr;
    let r = by.get(k);
    if (!r) by.set(k, r = { name: w.name, addr: w.addr, asked: 0, back: 0,
                            elsewhere: 0 });
    return r;
  };
  work().forEach((p) => {
    const back = p.answered_by || [];
    const names = new Set(back.map((w) => samePerson.name(w.name)));
    const boxes = new Set(back.map((w) => samePerson.box(w.addr)));
    const onCopy = new Set((p.to || []).map((w) => samePerson.name(w.name)
      || w.addr));
    (p.to || []).forEach((w) => {
      const r = get(w);
      r.asked++;
      if (names.has(samePerson.name(w.name))
        || boxes.has(samePerson.box(w.addr))) r.back++;
    });
    // Someone reading the list rather than their inbox: Simon Horman
    // answered seven of these and was on the copy list for none of them.
    // Without this his row would read "0 of 24" and look like indifference.
    back.forEach((w) => {
      if (!onCopy.has(samePerson.name(w.name) || w.addr)) get(w).elsewhere++;
    });
  });
  return [...by.values()].filter((r) => r.asked >= 8)
    .sort((a, b) => b.asked - a.asked);
}

// The list below has only people who replied, so a maintainer copied on
// forty patches who never said a word does not appear in it anywhere.
// That silence is the thing worth seeing.
function discAsked() {
  const rows = askedRows();
  if (rows.length < 4) return "";
  const top = rows.slice(0, 12);
  const quiet = rows.filter((r) => !r.back && !r.elsewhere);
  const asked = rows.reduce((a, r) => a + r.asked, 0);
  const back = rows.reduce((a, r) => a + r.back, 0);

  return `<div class="panel" data-reveal>
    <header><h2>Who answers when you copy them</h2>
      <span class="sub">${Math.round((back / asked) * 100)}% of asks
        answered</span></header>
    <div class="body">
      ${quiet.length ? `<p class="lede">${plural(quiet.length, "person", "people")}
        here ${quiet.length === 1 ? "has" : "have"} been copied on
        ${quiet.reduce((a, r) => a + r.asked, 0)} patches between them and
        never replied to one.</p>` : ""}
      <div class="bars welcome">
        ${top.map((r, i) => `<div class="barrow" data-reveal style="--i:${i}">
          <span class="nm">${mark(r.name)}</span>
          <div class="tr"><i style="width:${Math.max((r.back / r.asked) * 100,
            r.back ? 2 : 0)}%;background:${r.back / r.asked >= 0.4 ? C.green
              : r.back ? C.amber : C.grey}"></i></div>
          <span class="vl">${r.back} of ${r.asked}</span>
          <span class="why">${r.back
            ? `answered ${Math.round((r.back / r.asked) * 100)}%`
            : r.elsewhere
              ? `answered ${r.elsewhere} others`
              : "never answered"}</span></div>`).join("")}
      </div>
      <p class="foot">Counted from who was on To or Cc against who replied.
        Some maintainers work from the list rather than their inbox and
        answer patches they were never copied on, which is what the right
        hand column says where it does. Only people copied
        ${WELCOME_FLOOR + 2} times or more.</p>
    </div></div>`;
}

function discPeople() {
  return discAsked() + grid("people", S.data.people, [
    { key: "name", label: "Person", width: "40%", csv: (r) => r.name,
      render: (r) => `<strong>${mark(r.name)}</strong><div class="sub2">${esc(r.addr)}</div>` },
    { key: "replies", label: "Replies", cls: "num", render: (r) => r.replies },
    { key: "series", label: "Threads", cls: "num", render: (r) => r.series },
    { key: "tags", label: "Tags given", cls: "num", render: (r) => r.tags },
    { key: "kinds", label: "Which", sortable: false,
      csv: (r) => Object.entries(r.kinds).map(([t, n]) => `${t} ${n}`).join(" "),
      render: (r) => `<div class="chips">` + Object.entries(r.kinds).map(([t, n]) =>
        `<span class="pill ${t === "Nacked-by" ? "red" : "green"}">${esc(t)} ${n}</span>`
      ).join("") + `</div>` },
  ], {
    title: "People who engaged with your work",
    placeholder: "Search, or try replies>3\u2026",
    searchIn: (r) => r.name + " " + r.addr,
    fields: { name: (r) => r.name, replies: (r) => r.replies,
              tags: (r) => r.tags, threads: (r) => r.series },
    filters: [
      byColumn("gave", "Any tag given", (r) => Object.keys(r.kinds || {}).sort().join(", ")
        || "no tag, only replies"),
      byColumn("often", "However often", (r) => r.replies > 9 ? "10 or more replies"
        : r.replies > 2 ? "3 to 9 replies" : "1 or 2 replies"),
    ],
    groups: [{ key: "often", label: "by how often", of: (r) => r.replies > 9
               ? "10 or more replies" : r.replies > 2 ? "3 to 9 replies"
               : "1 or 2 replies" }],
    rowKey: (r) => r.addr || r.name,
    sort: "replies", dir: "desc", per: 25,
  });
}

function discTags() {
  const rows = S.data.tagrows;
  const byTag = {};
  rows.forEach((r) => { byTag[r.tag] = (byTag[r.tag] || 0) + 1; });
  const cards = Object.entries(byTag).sort((a, b) => b[1] - a[1])
    .map(([t, n], i) => `<div class="kpi ${["green", "blue", "cyan", "purple", "amber", "red"][i % 6]} flat"
      data-reveal style="--i:${i}">
      <div class="label">${esc(t)}</div>${counter(n, "tag-" + t)}</div>`).join("");

  return `<div class="kpis four">${cards}</div>` + grid("tags", rows, [
    { key: "tag", label: "Tag", csv: (r) => r.tag,
      render: (r) => `<span class="pill ${r.tag === "Nacked-by" ? "red" : "green"}">${esc(r.tag)}</span>` },
    { key: "who", label: "From", csv: (r) => r.who,
      render: (r) => `${mark(r.who)}<div class="sub2">${esc(r.addr)}</div>` },
    { key: "subject", label: "On patch", cls: "subject", width: "42%",
      csv: (r) => r.subject,
      render: (r) => `${subj(r.msgid || r.series, r.subject)}` },
    { key: "state", label: "Now", sort: (r) => state(r.state).rank,
      csv: (r) => state(r.state).label, render: (r) => pill(r.state) },
    { key: "date", label: "Given",
      render: (r) => `<span class="nowrap muted">${day(r.date)}</span>` },
  ], {
    title: "Review tags you collected",
    placeholder: "Search, or try tag:Reviewed-by\u2026",
    searchIn: (r) => [r.tag, r.who, r.subject].join(" "),
    fields: { tag: (r) => r.tag, who: (r) => r.who, state: (r) => r.state,
              sub: (r) => subsystem(r.subject) },
    filters: [
      byColumn("tag", "Any tag", (r) => r.tag),
      byColumn("who", "Anyone", (r) => r.who),
      stateFilter(),
      subsystemFilter(),
    ],
    groups: [{ key: "tag", label: "by tag", of: (r) => r.tag },
             { key: "who", label: "by person", of: (r) => r.who }],
    rowKey: (r) => r.tag + r.addr + r.subject,
    sort: "date", dir: "desc", per: 25,
  });
}

function viewInsights() {
  return tabs("ins", [
    ["activity", "Activity", insActivity],
    ["subsystem", "Subsystems", insSubsystems],
    ["trees", "Trees", insTrees],
    ["numbers", "Every number", insNumbers],
  ]);
}

function insActivity() {
  const d = S.data, tl = d.timeline;
  const byDate = {};
  tl.forEach((t) => { byDate[t.date] = t.sent; });
  const labels = tl.map((t) => t.date.slice(5));
  const daily = chartSlot("ins-daily", 230, (w, h) => lineChart(labels, [
    { name: "Patches posted", color: C.blue, points: tl.map((t) => t.sent), fill: true },
    { name: "Series posted", color: C.amber, points: tl.map((t) => t.series) },
    { name: "Landed", color: C.green, points: tl.map((t) => t.merged) },
  ], w, h));
  const cumulative = chartSlot("ins-total", 190, (w, h) => lineChart(labels, [
    { name: "Running total", color: C.purple, points: tl.map((t) => t.cumulative), fill: true },
  ], w, h));

  const busiest = tl.slice().sort((a, b) => b.sent - a.sent).slice(0, 8);
  const bmax = Math.max(...busiest.map((t) => t.sent), 1);

  return `<div class="stack">
    <div class="panel" data-reveal>
      <header><h2>When you post</h2>
        <span class="sub">a square per day, the last six months</span></header>
      <div class="body">${heatmap(byDate, 26)}</div>
    </div>
    <div class="panel" data-reveal>
      <header><h2>Day by day</h2><div class="spacer"></div>
        <div class="chartlegend">
          <span><i style="background:${C.blue}"></i>patches</span>
          <span><i style="background:${C.amber}"></i>series</span>
          <span><i style="background:${C.green}"></i>landed</span>
        </div></header>
      <div class="body">${daily}</div>
    </div>
    <div class="row2">
      <div class="panel" data-reveal><header><h2>Running total</h2></header>
        <div class="body">${cumulative}</div></div>
      <div class="panel" data-reveal><header><h2>Busiest days</h2></header>
        <div class="body"><div class="bars">${busiest.map((t, i) => `<div class="barrow"
          data-reveal style="--i:${i}">
          <span class="nm">${esc(t.date)}</span>
          <div class="tr"><i style="width:${(t.sent / bmax) * 100}%;background:${C.blue}"></i></div>
          <span class="vl">${t.sent}</span></div>`).join("")}</div></div></div>
    </div>
  </div>`;
}

function subsystemRows() {
  const map = {};
  work().forEach((p) => {
    const s = subsystem(p.subject);
    const g = map[s] || (map[s] = { name: s, patches: 0, merged: 0, next: 0,
                                    review: 0, open: 0, bad: 0 });
    g.patches++;
    if (p.state === "merged") g.merged++;
    else if (["in-next", "in-tree", "accepted", "queued"].includes(p.state)) g.next++;
    else if (["reviewed", "under-review"].includes(p.state)) g.review++;
    else if (CLOSED.includes(p.state) || p.state === "changes-requested") g.bad++;
    else g.open++;
  });
  return Object.values(map).sort((a, b) => b.patches - a.patches);
}

// A rate needs something behind it: one patch that landed is not a
// subsystem that takes your work, and a list of those would put whatever
// you happened to send once at the top of the page.
const WELCOME_FLOOR = 6;

function welcomeRows() {
  return subsystemRows()
    .filter((r) => r.patches >= WELCOME_FLOOR)
    .map((r) => Object.assign({}, r, { in: r.merged + r.next }))
    .map((r) => Object.assign(r, { rate: r.in / r.patches }))
    .sort((a, b) => b.rate - a.rate || b.patches - a.patches);
}

// Sorting the subsystems by how much you sent answers "where have I been
// working".  This answers the more useful question, which is where that
// work was wanted -- and the two orders are nothing like each other,
// because the places you send most are not the places that take most.
function insWelcome() {
  const rows = welcomeRows();
  if (rows.length < 3) return "";
  const best = rows[0], worst = rows[rows.length - 1];
  const all = work().length;
  const landed = work().filter((p) => p.state === "merged"
    || ["in-next", "in-tree", "accepted", "queued"].includes(p.state)).length;

  const tail = (r) => {
    if (r.open && r.open >= r.bad) return `${r.open} never answered`;
    if (r.bad) return `${r.bad} turned down`;
    return r.review ? `${r.review} still being read` : "";
  };

  return `<div class="panel wide" data-reveal>
    <header><h2>Where the work is wanted</h2>
      <span class="sub">${Math.round((landed / all) * 100)}% of everything
        lands</span></header>
    <div class="body">
      <p class="lede">${esc(best.name)}/ has taken ${best.in} of the
        ${best.patches} you sent it. ${esc(worst.name)}/ has taken
        ${worst.in ? `only ${worst.in}` : "none"} of ${worst.patches}.</p>
      <div class="bars welcome">
        ${rows.map((r, i) => `<div class="barrow" data-reveal style="--i:${i}">
          <span class="nm">${esc(r.name)}/</span>
          <div class="tr"><i style="width:${Math.max(r.rate * 100, r.in ? 2 : 0)}%;
            background:${r.rate >= 0.6 ? C.green : r.rate >= 0.25 ? C.amber
              : C.red}"></i></div>
          <span class="vl">${r.in} of ${r.patches}</span>
          <span class="why">${tail(r)}</span></div>`).join("")}
      </div>
      <p class="foot">Much the same patch does well in some of these and
        goes nowhere in others, so the difference is the subsystem rather
        than the work. The bottom of this list is where to send something
        different, or nothing.</p>
    </div></div>`;
}

function insSubsystems() {
  const d = S.data;
  const rows = subsystemRows();
  const items = rows.slice(0, 7).map((r, i) =>
    ({ label: r.name + "/", value: r.patches, color: PALETTE[i] }));
  const rest = rows.slice(7).reduce((a, b) => a + b.patches, 0);
  if (rest) items.push({ label: "everything else", value: rest, color: C.grey });

  return insWelcome() + `<div class="panel" data-reveal>
      <header><h2>Where your work goes</h2>
        <span class="sub">${plural(rows.length, "subsystem")} touched</span></header>
      <div class="body"><div class="donutwrap">
        ${donut(items, 170, rows.length, "areas")}
        ${legend(items, work().length)}</div></div>
    </div>` + grid("subsystems", rows, [
      { key: "name", label: "Subsystem", csv: (r) => r.name,
        render: (r) => `<strong>${mark(r.name)}/</strong>` },
      { key: "patches", label: "Patches", cls: "num", render: (r) => r.patches },
      { key: "bar", label: "How they are doing", sortable: false, width: "38%",
        csv: (r) => `${r.merged} mainline, ${r.next} accepted, ${r.open} waiting`,
        render: (r) => `<div class="barrow" style="grid-template-columns:1fr">
          ${stackBar([
            { label: "in mainline", value: r.merged, color: C.green },
            { label: "accepted", value: r.next, color: C.cyan },
            { label: "in review", value: r.review, color: C.amber },
            { label: "no reply yet", value: r.open, color: C.grey },
            { label: "closed out", value: r.bad, color: C.red },
          ], r.patches)}</div>` },
      { key: "merged", label: "Mainline", cls: "num", render: (r) => r.merged },
      { key: "next", label: "Accepted", cls: "num", render: (r) => r.next },
      { key: "open", label: "Waiting", cls: "num", render: (r) => r.open },
    ], {
      placeholder: "Search, or try patches>10\u2026",
      searchIn: (r) => r.name,
      fields: { name: (r) => r.name, patches: (r) => r.patches,
                merged: (r) => r.merged, open: (r) => r.open },
      filters: [byColumn("how", "However they are doing", (r) => r.merged
        ? "something in mainline" : r.next ? "something accepted"
        : r.review ? "under review" : r.open ? "still waiting"
        : "nothing moving")],
      rowKey: (r) => r.name, sort: "patches", dir: "desc", per: 25,
    });
}

function insTrees() {
  const d = S.data, cap = d.kpis.netdev_cap, open = d.kpis.netdev_open;
  const over = open >= cap;
  const budget = `<div class="panel" data-reveal>
    <header><h2>net-next budget</h2>
      <span class="sub">Documentation/process/maintainer-netdev.rst</span></header>
    <div class="body">
      <div class="gauge"><i style="width:${Math.min(100, (open / cap) * 100)}%;
        background:${over ? C.red : C.amber}"></i></div>
      <p class="hint"><strong>${open} of ${cap}</strong> patches outstanding against
      net-next. Netdev asks for no more than ${cap} across all your series, so
      ${over ? "anything further has to wait for this batch to be applied."
             : `you have room for ${cap - open} more.`}</p>
    </div></div>`;

  return budget + grid("trees", d.trees, [
    { key: "tree", label: "Tree or list", csv: (r) => r.tree,
      render: (r) => `<strong>${mark(r.tree)}</strong>` },
    { key: "patches", label: "Patches", cls: "num", render: (r) => r.patches },
    { key: "bar", label: "How they are doing", sortable: false, width: "32%",
      csv: (r) => `${r.merged} mainline, ${r.in_next} next, ${r.open} open`,
      render: (r) => `<div class="barrow" style="grid-template-columns:1fr">
        ${stackBar([
          { label: "in mainline", value: r.merged, color: C.green },
          { label: "in linux-next", value: r.in_next, color: C.cyan },
          { label: "accepted", value: r.accepted, color: C.blue },
          { label: "reviewed", value: r.reviewed, color: C.amber },
          { label: "open", value: r.open, color: C.grey },
          { label: "closed out", value: r.problems, color: C.red },
        ], r.patches)}</div>` },
    { key: "merged", label: "Mainline", cls: "num", render: (r) => r.merged },
    { key: "in_next", label: "linux-next", cls: "num", render: (r) => r.in_next },
    { key: "open", label: "Open", cls: "num", render: (r) => r.open },
    { key: "tags", label: "Tags", cls: "num", render: (r) => r.tags },
  ], {
    placeholder: "Search, or try open>5\u2026",
    searchIn: (r) => r.tree,
    fields: { tree: (r) => r.tree, patches: (r) => r.patches,
              merged: (r) => r.merged, open: (r) => r.open, tags: (r) => r.tags },
    filters: [byColumn("how", "However they are doing", (r) => r.merged
      ? "something in mainline" : r.in_next ? "something in linux-next"
      : r.open ? "still waiting" : "nothing moving")],
    rowKey: (r) => r.tree, sort: "patches", dir: "desc", per: 25,
  });
}

function insNumbers() {
  const d = S.data, k = d.kpis;
  /* Every count on this table comes off the same one-row-per-patch set as
     the rest of the site.  It used to mix that with the server's
     per-posting totals, which is how two panels could both be right and
     still disagree. */
  const rows = work();
  const n = (f) => rows.filter(f).length;
  const st = (...names) => n((p) => names.includes(p.state));
  const sent = rows.reduce((a, p) => a + (p.sent || 1), 0);

  const numbers = [
    ["Patches written", rows.length],
    ["Mails sent to post them", sent],
    ["Sent more than once", n((p) => (p.sent || 1) > 1)],
    ["Series they belong to", seriesCount()],
    ["Series respun as v2 or later", k.versions],
    ["In mainline", st("merged")], ["In linux-next", st("in-next")],
    ["In a maintainer tree", st("in-tree")],
    ["Marked accepted", st("accepted", "queued", "awaiting-upstream")],
    ["Carrying a review tag", st("reviewed")],
    ["Being discussed", st("under-review", "needs-ack")],
    ["No response yet", st("awaiting")],
    ["Changes requested", st("changes-requested")],
    ["Rejected", st("rejected")],
    ["Not applicable or handled elsewhere",
     st("not-applicable", "handled-elsewhere", "deferred")],
    ["Review tags collected", k.review_tags], ["People who replied", k.reviewers],
    ["Replies received", k.replies], ["Threads waiting on you", k.waiting_on_us],
    ["Trees and lists targeted", k.trees], ["Patchwork projects", k.pw_projects],
    ["First patch posted", day(k.first)], ["Most recent patch posted", day(k.last)],
  ];

  const buckets = { "1 patch": 0, "2 to 4": 0, "5 to 9": 0, "10 to 19": 0, "20 or more": 0 };
  d.series.forEach((s) => {
    if (s.count === 1) buckets["1 patch"]++;
    else if (s.count < 5) buckets["2 to 4"]++;
    else if (s.count < 10) buckets["5 to 9"]++;
    else if (s.count < 20) buckets["10 to 19"]++;
    else buckets["20 or more"]++;
  });
  const bmax = Math.max(...Object.values(buckets), 1);

  return `<div class="row2" style="align-items:start">
    <div class="panel" data-reveal><header><h2>Every number</h2>
      <div class="spacer"></div>
      ${info("numbers", `Each patch is counted once, at the version that
        speaks for it, which is why "patches written" is smaller than
        "mails sent to post them". The status counts below add up to the
        first of those, not the second.`)}</header>
      <div class="body"><dl class="kv">${numbers.map(([a, b]) =>
        `<dt>${esc(a)}</dt><dd class="num">${esc(b)}</dd>`).join("")}</dl></div></div>
    <div class="panel" data-reveal><header><h2>How big your series are</h2></header>
      <div class="body"><div class="bars">${Object.entries(buckets).map(([nm, v], i) =>
        `<div class="barrow" data-reveal style="--i:${i}"><span class="nm">${esc(nm)}</span>
          <div class="tr"><i style="width:${(v / bmax) * 100}%;background:${PALETTE[i]}"></i></div>
          <span class="vl">${v}</span></div>`).join("")}</div></div></div>
  </div>`;
}

/* What you owe the lists, as against what the lists owe you.  Two kinds:
   a thread where someone asked you something last, and a series where the
   answer was "change this", which means a new version is due. */
/* Patches nobody has said anything about, gathered by the run that sent
   them.

   Sorting these by age gives a list that reads as a hundred and nine
   separate failures when it is one: a send-email run goes out in a single
   afternoon, and every patch in it is the same age, waiting on the same
   silence, needing the same one decision. Grouped by the day they left,
   that is what it looks like -- a handful of sends, each either ripe for a
   ping or not yet. */
function quietWork() {
  const rows = work().filter((p) => !CLOSED.includes(p.state));
  const sent = new Map();                    // day -> how many went out
  rows.forEach((p) => {
    const d = (p.date || "").slice(0, 10);
    if (d) sent.set(d, (sent.get(d) || 0) + 1);
  });

  const runs = new Map();
  rows.filter((p) => reached(p) === 0).forEach((p) => {
    const d = (p.date || "").slice(0, 10);
    if (!d) return;
    let g = runs.get(d);
    if (!g) runs.set(d, g = { day: d, patches: [], lists: new Set() });
    g.patches.push(p);
    const where = treeOf(p);
    if (where && where !== "unspecified") g.lists.add(where);
  });

  return [...runs.values()].map((g) => ({
    ...g,
    age: -days(g.day),
    sent: sent.get(g.day) || g.patches.length,
    lists: [...g.lists].sort(),
  })).sort((a, b) => b.age - a.age);
}

/* Kernel custom is to leave a fortnight before nudging, and the merge
   window suspends even that: for those two weeks maintainers are sending
   pull requests to Linus, so nobody is ignoring anything. */
const PING_AFTER = 14;

/* The verdict on one run, and a few words only where those words differ
   from the run above. Why a ping is the right move is the same paragraph
   for every ripe send, so it is said once over the list rather than six
   times down it. */
function pingVerdict(run) {
  const c = S.data.cycle || {};
  if (c.phase === "merge-window") return ["hold", "Wait", ""];
  if (run.age < PING_AFTER) {
    return ["early", "Too early",
            `${plural(PING_AFTER - run.age, "day")} to go.`];
  }
  return ["ripe", "Worth a ping", ""];
}

/* The advice itself, once, above the list. */
function pingAdvice(runs) {
  const c = S.data.cycle || {};
  const ripe = runs.filter((r) => pingVerdict(r)[0] === "ripe").length;
  if (c.phase === "merge-window") {
    return `The ${esc(c.next || "next")} merge window is open, which is the one
      fortnight where silence means nothing at all: maintainers are sending
      pull requests to Linus rather than reading the list. Let it shut${
        c.closes ? " " + when(c.closes) : ""} before reading anything into
      these.`;
  }
  if (!ripe) {
    return `Kernel custom is to leave a week or two before nudging, and
      nothing here has waited that long yet.`;
  }
  return `${c.tag ? esc(c.tag) + ", so review is running normally and this is "
    : "This is "}silence rather than the calendar. The custom is to nudge by
    replying to your own posting on the list, not by sending the patches
    again.`;
}

function owedWork() {
  const d = S.data;
  const byId = new Map(d.series.map((s) => [s.id, s]));
  const waiting = new Set(d.series.filter((s) => s.waiting_on_us).map((s) => s.id));

  const rows = work();
  const groups = new Map();
  rows.filter(owesRespin).forEach((p) => {
    let g = groups.get(p.series);
    if (!g) {
      const s = byId.get(p.series) || {};
      groups.set(p.series, g = {
        id: p.series,
        name: s.name || p.series_name || p.subject,
        tree: s.tree_hint || s.list || treeOf(p),
        lore: s.lore || p.lore,
        date: s.last_activity || s.date || p.date,
        sent: s.version || p.version || 1,
        patches: [],
      });
    }
    g.patches.push(p);
    g.sent = Math.max(g.sent, p.version || 1);
  });
  const respins = [...groups.values()]
    .sort((a, b) => compare(b.date, a.date));

  /* Which patches the waiting threads are actually about. A send-email run
     that lost its threading is one series holding fourteen conversations, so
     counting the whole series here credits one unanswered question with
     thirteen patches nobody has said anything about. */
  const asked = conversations().filter((t) => t.waiting_on_us);
  const stems = new Set(asked.map((t) => t.stem).filter(Boolean));

  return {
    replies: {
      threads: asked,
      patches: rows.filter((p) => (stems.size && p.stem
                                   ? stems.has(p.stem)
                                   : waiting.has(p.series))),
    },
    respin: {
      series: respins,
      patches: rows.filter(owesRespin),
    },
    dropped: rows.filter(closed),
  };
}

/* Whether a new version is actually owed, which is not the same question as
   whether the state reads "changes requested".

   Patchwork records that state whoever set it, so an author writing "please
   drop this, three of the changes are wrong" leaves the same mark as a
   maintainer demanding a rewrite; and a v2 that merged two patches into one
   is retitled, so the v1 keeps the state for ever. The collector works this
   out with the thread in front of it. Older collections did not, and for
   those the state is still the best guess available. */
function owesRespin(p) {
  return "respin_owed" in p ? p.respin_owed : p.state === "changes-requested";
}

function viewOwed() {
  const owed = owedWork();
  return tabs("owed", [
    ["replies", `Replies (${owed.replies.threads.length})`,
     () => owedReplies(owed)],
    ["respin", `New versions (${owed.respin.series.length})`,
     () => owedRespins(owed)],
    /* Counted in sends, and said so.  The ledger on the overview counts the
       same silence in patches, and two different numbers both labelled "no
       reply" read as one of them being wrong. */
    ["quiet", `No reply (${plural(quietWork().length, "send")})`, owedQuiet],
    ["notes", `Your notes (${(S.data.notes || []).length})`, owedNotes],
  ]);
}

function owedQuiet() {
  const runs = quietWork();
  if (!runs.length) {
    return `<div class="panel" data-reveal><div class="empty">
      <div class="emptyicon">\u2713</div>
      <p>Everything you have posted has had an answer of some kind.</p>
      </div></div>`;
  }
  const ripe = runs.filter((r) => pingVerdict(r)[0] === "ripe");
  const cards = runs.map((run, i) => {
    const [cls, head, why] = pingVerdict(run);
    const n = run.patches.length;
    const rows = run.patches.slice(0, 6).map((p) => `<li>
      ${subj(p.msgid || p.key, p.raw_subject || p.subject)}</li>`).join("");
    const more = n - 6;
    return `<div class="quietrun ${cls}" data-reveal style="--i:${i}">
      <div class="qhead">
        <span class="pill ${cls === "ripe" ? "amber" : "grey"}">${esc(head)}</span>
        <b>${esc(longDay(run.day))}</b>
        <span class="muted">${plural(run.age, "day")} ago</span>
        <span class="spacer"></span>
        <span class="muted">${run.lists.slice(0, 3).map(esc).join(", ")}${
          run.lists.length > 3 ? ` +${run.lists.length - 3}` : ""}</span>
      </div>
      <p class="qwhy">${n === run.sent
        ? `${n === 1 ? "The one patch" : n === 2 ? "Both patches"
            : `All ${n} patches`} sent that day, still unanswered.`
        : `${n} of the ${plural(run.sent, "patch", "patches")} sent that day,
           still unanswered.`}${why ? " " + why : ""}</p>
      <ul class="qlist">${rows}${more > 0
        ? `<li class="qmore">and ${more} more</li>` : ""}</ul>
    </div>`;
  }).join("");

  return `<div class="panel" data-reveal>
    <header><h2>Nobody has answered</h2>
      <span class="sub">${plural(runs.length, "send")}, oldest first${
        ripe.length ? ` \u00b7 ${ripe.length} worth a ping` : ""}</span>
    </header>
    <p class="hint qadvice">${pingAdvice(runs)}</p>
    <div class="body flush">${cards}</div></div>`;
}

/* "4 September", or with the year once it is no longer this one. */
function longDay(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const opts = { day: "numeric", month: "long", timeZone: "UTC" };
  if (d.getUTCFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function owedReplies(owed) {
  const list = owed.replies.threads;
  if (!list.length) {
    return `<div class="panel" data-reveal><div class="empty">
      <div class="emptyicon">\u2713</div>
      <p>Nothing on the lists is waiting for you.</p></div></div>`;
  }
  const cards = list.map((t, i) => `
    <div class="notecard" data-reveal style="--i:${i}">
      <span class="pill amber">reply</span>
      <div class="tx">
        <h4>${subj(t.msgid || t.id, t.series)}</h4>
        <p><strong>${esc(t.last_from)}</strong> wrote ${ago(t.last_date)}:
           ${esc(t.excerpt)}</p>
        <div class="next">
          <button class="link" ${act(askAboutThread, t)}>ask the assistant what to say</button>
          <span class="muted"> \u00b7 ${esc(t.tree || "list")} \u00b7 ${
            plural(t.count, "message")}</span>
        </div>
      </div></div>`).join("");

  return `<div class="panel" data-reveal>
    <header><h2>Someone asked you something</h2>
      <span class="sub">${plural(list.length, "thread")}, covering ${
        plural(owed.replies.patches.length, "patch", "patches")}</span></header>
    <div class="body flush">${cards}</div></div>`;
}

function owedRespins(owed) {
  const list = owed.respin.series;
  if (!list.length) {
    /* Saying "nobody asked for changes" to somebody looking at a row of
       patches marked Changes requested reads as a bug in the page. Say which
       of the two it is. */
    const settled = work().filter((p) => p.state === "changes-requested");
    return `<div class="panel" data-reveal><div class="empty">
      <div class="emptyicon">\u2713</div>
      <p>${settled.length
        ? `Changes were asked for on ${plural(settled.length, "patch", "patches")},
           and every one of them has been answered already.`
        : "Nobody has asked for changes. Nothing to respin."}</p>
      </div></div>`;
  }
  const cards = list.map((g, i) => `
    <div class="notecard" data-reveal style="--i:${i}">
      <span class="pill purple">v${g.sent + 1} due</span>
      <div class="tx">
        <h4>${subj(g.id, g.name)}</h4>
        <p>${plural(g.patches.length, "patch", "patches")} with changes
           requested, last moved ${ago(g.date)}. You sent v${g.sent}, so the
           next one goes out as <strong>v${g.sent + 1}</strong>.</p>
        <ul class="tight">${g.patches.map((p) =>
          `<li>${subj(p.msgid || p.series, p.subject)}${p.state_detail
              ? ` <span class="muted">\u2014 ${esc(p.state_detail)}</span>` : ""}</li>`
          ).join("")}</ul>
        <div class="next">
          <button class="link" ${act(askAboutRespin, g)}>ask the assistant what to change</button>
        </div>
      </div>
      <span class="muted nowrap">${esc(g.tree)}</span>
    </div>`).join("");

  return `<div class="panel" data-reveal>
    <header><h2>Changes were requested</h2>
      <span class="sub">${plural(list.length, "series", "series")}, ${
        plural(owed.respin.patches.length, "patch", "patches")} to respin</span>
      <div class="spacer"></div>
      <button class="link" ${act(showBucket, "respin")}>see them in the list</button>
    </header>
    <div class="body flush">${cards}</div></div>`;
}

function owedNotes() {
  const notes = S.data.notes || [];
  const withheld = S.status.notes_withheld || S.data.notes_withheld || 0;
  const colour = { blocked: "red", todo: "amber", waiting: "purple",
                   held: "grey", rule: "blue" };
  const cards = notes.map((n, i) => `<div class="notecard" data-reveal style="--i:${i}">
      <span class="pill ${colour[n.state] || "grey"}">${esc(n.state)}</span>
      <div class="tx"><h4>${esc(n.title)}</h4><p>${esc(n.detail)}</p>
        ${n.next ? `<div class="next">Next: ${esc(n.next)}</div>` : ""}</div>
      <span class="muted nowrap">${esc(n.tree || "")}</span>
    </div>`).join("") || (withheld
      ? `<div class="empty"><div class="emptyicon">\u26BF</div>
         <p>${plural(withheld, "private note")} withheld by this deployment.<br>
         They stay on the machine that collected them.</p></div>`
      : `<div class="empty"><div class="emptyicon">\u2691</div>
         <p>Nothing written down yet.</p></div>`);

  return `<div class="panel" data-reveal>
    <header><h2>Things you wrote down</h2>
      <span class="sub">what is blocked, and what to fix next time</span></header>
    <div class="body flush">${cards}</div></div>`;
}

/* -------------------------------------------------------------- settings */

function viewSettings() {
  loadSupport();
  return tabs("set", [
    ["general", "General", setGeneral],
    ["ai", "Assistant", setAI],
    ["sources", "Data sources", setSources],
    ["support", "Support", setSupport],
  ]);
}

/* What everybody sent, for the one account that may read it.

   Drawn only for the owner, and that is not what makes it safe: the server
   decides who the owner is and checks it again on every request behind
   this page, so a tab that is merely not drawn is not a permission. */
function viewInbox() {
  if (!(S.support || {}).owner) {
    return `<div class="panel" data-reveal><div class="body">
      <div class="empty"><div class="emptyicon">\u2298</div>
      <h3>That is not yours to read</h3>
      <p>Reports people send here go to whoever runs this deployment.</p>
      </div></div></div>`;
  }
  return setInbox();
}

/* Everything everybody sent, and the way to answer it.

   An answer is a status and, if there is something to say, a note; both go
   back to whoever wrote the report, by mail if this server has mail and on
   their own Support tab either way. */
function setInbox() {
  loadInbox();
  const rows = S.inbox || [];
  const pick = S.inboxPick || "";

  if (!S.inboxAsked) {
    return `<div class="panel wide" data-reveal><div class="body">
      <p class="hint" style="margin:0"><span class="spin"></span>
      Reading what people sent\u2026</p></div></div>`;
  }
  if (!rows.length) {
    return `<div class="panel wide" data-reveal><div class="body">
      <div class="empty"><div class="emptyicon">\u2709</div>
      <h3>Nothing has been sent yet</h3>
      <p>Anything written on the Support tab arrives here.</p>
      </div></div></div>`;
  }

  const counts = {};
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const cards = Object.keys(FEEDBACK_STATUS).filter((k) => counts[k])
    .map((k, i) => `<div class="kpi ${fbStatus(k)[1]} flat" data-reveal
      style="--i:${i}"><div class="label">${esc(fbStatus(k)[0])}</div>
      ${counter(counts[k], "fb-" + k)}</div>`).join("");

  return `<div class="kpis four">${cards}</div>`
    + grid("inbox", rows, [
      { key: "kind", label: "What", sort: (r) => r.kind,
        csv: (r) => fbKind(r.kind)[1],
        render: (r) => `<span class="pill ${fbKind(r.kind)[3]} nowrap"
          title="${esc(fbKind(r.kind)[1])}">${fbKind(r.kind)[2]} ${
          esc(fbKind(r.kind)[4] || fbKind(r.kind)[1])}</span>` },
      { key: "text", label: "What they said", cls: "subject", width: "40%",
        csv: (r) => r.text,
        render: (r) => `<button class="said" title="Answer this"
          ${act(openReport, r.id)}>${mark(r.text.slice(0, 160))}${
          r.text.length > 160 ? "\u2026" : ""}</button>
          ${(r.answers || []).length ? `<div class="sub2">${
            plural(r.answers.length, "answer")} sent</div>` : ""}` },
      { key: "who", label: "From", csv: (r) => r.who,
        render: (r) => `${mark(r.name || r.who)}${r.name
          ? `<div class="sub2">${esc(r.who)}</div>` : ""}` },
      { key: "where", label: "On page", csv: (r) => r.where,
        render: (r) => r.where
          ? `<span class="nowrap muted">${esc(r.where)}</span>`
          : `<span class="muted">\u2014</span>` },
      { key: "status", label: "Status", sort: (r) => r.status,
        csv: (r) => fbStatus(r.status)[0],
        render: (r) => `<span class="pill ${fbStatus(r.status)[1]}">${
          esc(fbStatus(r.status)[0])}</span>` },
      { key: "at", label: "Sent",
        render: (r) => `<span class="nowrap muted">${ago(r.at)}</span>` },
      { key: "do", label: "", sortable: false,
        render: (r) => `<button class="btn sm" ${act(openReport, r.id)}>${
          pick === r.id ? "Close" : "Answer"}</button>` },
    ], {
      title: "What people sent",
      subtitle: `${plural(rows.length, "report")}, newest first`,
      placeholder: "Search what somebody wrote\u2026",
      searchIn: (r) => [r.text, r.who, r.name, r.kind, r.status].join(" "),
      fields: { kind: (r) => r.kind, status: (r) => r.status,
                who: (r) => r.who, where: (r) => r.where },
      filters: [
        byColumn("status", "Any status", (r) => r.status,
                 (k) => fbStatus(k)[0]),
        byColumn("kind", "Anything", (r) => r.kind, (k) => fbKind(k)[1]),
        byColumn("who", "Anyone", (r) => r.name || r.who),
        byColumn("where", "Any page", (r) => r.where || "not said"),
      ],
      groups: [{ key: "status", label: "by status", of: (r) => fbStatus(r.status)[0] },
               { key: "kind", label: "by kind", of: (r) => fbKind(r.kind)[1] }],
      rowKey: (r) => r.id,
      sort: "at", dir: "desc", per: 15,
    })
    + answerPanel(rows.find((r) => r.id === pick));
}

function answerPanel(r) {
  if (!r) return "";
  const draft = S.answer || {};
  return `<div class="panel wide answering" data-reveal>
    <header><h2>Answer ${esc(r.name || r.who)}</h2>
      <span class="sub">${esc(fbKind(r.kind)[1])} \u00b7 ${ago(r.at)}</span>
      <div class="spacer"></div>
      <button class="iconbtn" ${act(openReport, r.id)}>&times;</button>
    </header>
    <div class="body">
      <p class="quoted">${esc(r.text)}</p>
      ${(r.answers || []).length ? `<div class="answered">${
        r.answers.map((a) => `<div class="mreply">
          <strong>${esc(fbStatus(a.status)[0])}</strong>
          ${a.note ? `<p>${esc(a.note)}</p>` : ""}
          <span class="muted">${ago(a.at)}</span></div>`).join("")}</div>` : ""}
      <div class="field">
        <label>Where it stands</label>
        <div class="presets">${Object.keys(FEEDBACK_STATUS).map((k) => `
          <button class="chip ${draft.status === k ? "on" : ""}"
            ${act(pickStatus, k)}>${esc(fbStatus(k)[0])}</button>`).join("")}
        </div>
      </div>
      <div class="field">
        <label>Anything to say to them</label>
        <textarea id="answote" data-search="ans" rows="3"
          ${actv("input", answerTyped)}
          placeholder="Optional. They will get this as it is written."
          >${esc(draft.note || "")}</textarea>
      </div>
      <div class="btnrow">
        <button class="btn primary" ${act(sendAnswer, r.id)}
          ${!draft.status || draft.busy ? "disabled" : ""}>${
          draft.busy ? "Sending\u2026" : "Send it"}</button>
      </div>
      ${draft.error ? `<p class="testline bad">${esc(draft.error)}</p>` : ""}
      ${draft.done ? `<p class="testline ok">${esc(draft.done)}</p>` : ""}
    </div>
  </div>`;
}

function openReport(id) {
  const same = S.inboxPick === id;
  S.inboxPick = same ? "" : id;
  S.answer = same ? {} : { status: "", note: "" };
  render();
  /* The answer opens under the table, which on a long one is under the
     bottom of the window: pressing Answer looked like it had done nothing
     except change the button to Close. */
  if (!same) {
    requestAnimationFrame(() => {
      const panel = document.querySelector(".answering");
      if (panel) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
}

function pickStatus(k) {
  S.answer = Object.assign({}, S.answer, { status: k, error: "", done: "" });
  render();
}

function answerTyped(value) {
  S.answer = Object.assign({}, S.answer, { note: value });
}

async function sendAnswer(id) {
  const a = S.answer || {};
  if (!a.status) return;
  S.answer = Object.assign({}, a, { busy: true, error: "", done: "" });
  render();
  try {
    const r = await post("/api/feedback/answer",
                         { id, status: a.status, note: a.note || "" });
    const body = await r.json();
    if (!body.ok) {
      S.answer = Object.assign({}, S.answer,
                               { busy: false, error: body.error || "No." });
    } else {
      /* Said as a toast rather than in the panel, because sending an
         answer closes the panel: the line about where it went was being
         written into something that had just been taken off the screen,
         so the whole thing simply vanished and left nobody any the wiser
         about whether the person had been told. */
      toast(body.told ? "Answered, and they have been mailed."
                      : "Answered. They will see it on their Support tab.");
      S.answer = {};
      S.inboxPick = "";
      S.inboxAsked = false;
      loadInbox();
    }
  } catch (e) {
    S.answer = Object.assign({}, S.answer,
                             { busy: false, error: "Could not reach it." });
  }
  render();
}

async function loadInbox() {
  if (S.inboxAsked) return;
  S.inboxAsked = true;
  try {
    const r = await fetch("/api/feedback", { cache: "no-store" });
    const body = await r.json();
    if (body.ok) S.inbox = body.rows || [];
    render();
  } catch (e) { /* the tab says it is empty, which is all it can say */ }
}

const INTERVAL_PRESETS = [2, 5, 15, 30, 60, 240, 1440];

function prettyInterval(m) {
  if (!m) return "\u2014";
  if (m < 60) return `${+m.toFixed(2)} min`;
  if (m < 1440) return `${+(m / 60).toFixed(m % 60 ? 1 : 0)} hr`;
  return `${+(m / 1440).toFixed(m % 1440 ? 1 : 0)} day`;
}

function setGeneral() {
  const d = S.data, st = S.status;
  const auto = st.auto !== false;
  const now = st.interval || 15;
  return `<div class="row2" style="align-items:start">
    <div class="panel" data-reveal><header><h2>Automatic refresh</h2>
      <div class="spacer"></div>
      ${info("auto", `The server re-reads lore, patchwork and git.kernel.org on
        a timer, so this page stays current on its own. Responses are cached,
        so a scheduled run is cheap and usually finishes in a second.`)}
    </header><div class="body">
      <div class="switchrow">
        <label class="switch"><input type="checkbox" ${auto ? "checked" : ""}
          ${actv("change", setAuto)}><span></span></label>
        <div><strong>${auto ? "On" : "Off"}</strong>
          <div class="sub2">${auto
            ? "next run " + (st.next_run ? "in " + until(st.next_run) : "shortly")
            : "the page will only update when you refresh by hand"}</div></div>
      </div>

      <div class="field">
        <label>How often</label>
        <div class="intervalrow">
          <input type="number" id="ivnum" min="1" max="10080" step="1" value="${now}">
          <span class="unit">minutes</span>
          <button class="btn sm" ${act(applyInterval)}>Apply</button>
        </div>
        <div class="presets">
          ${INTERVAL_PRESETS.map((m) => `<button class="chip ${
            Math.abs(now - m) < 0.01 ? "on" : ""}" ${act(setInterval_, m)}
            >${prettyInterval(m)}</button>`).join("")}
        </div>
          <p class="hint">Currently <strong>${prettyInterval(now)}</strong>.
          ${info("ivl", `Anything from one minute to a week is allowed. The
            schedule is yours and is remembered, so signing in again, or from
            another machine, finds the same one.`)}</p>
      </div>

      <div class="btnrow">
        <button class="btn primary" ${act(doRefresh, false)}>Refresh now</button>
        <button class="btn" ${act(doRefresh, true)}>Full rescan</button>
      </div>
      <p class="hint">Refresh now re-reads the lists and patchwork.
      ${info("rescan", `A full rescan does that and then walks all eighty
      maintainer trees on git.kernel.org, which takes several minutes. You
      only need it if a commit of yours landed somewhere unusual.`)}</p>
    </div></div>

    <div class="panel" data-reveal><header><h2>When a patch lands</h2>
      <div class="spacer"></div>
      ${info("landmail", `A patch reaching Linus' tree is the end of the whole
        thing, and the one part of it nobody announces: the maintainer said
        "applied" weeks ago, and then one day the commit is simply there.
        This is the only message Patchvane will send you about your own
        patches. It goes to the address on your account &mdash; Profile has
        it &mdash; after a collection finds a commit of yours in mainline
        that was not there last time, with the subject, the commit and when
        it landed. Switching it on now does not mean hearing about
        everything that has already landed: what has been seen is remembered
        either way, so you get the next one, not the back catalogue.`)}
    </header>
    <div class="body">
      <div class="switchrow">
        <label class="switch"><input type="checkbox" ${st.merged_mail ? "checked" : ""}
          ${actv("change", setMergedMail)}><span></span></label>
        <div><strong>${st.merged_mail ? "On" : "Off"}</strong>
          <div class="sub2">${st.merged_mail
            ? "you will hear from us when one reaches mainline, and not "
              + "otherwise"
            : "nothing is sent"}</div></div>
      </div>
      ${st.mail === false ? `<p class="testline bad">This server has no way to
        send mail configured, so nothing can go out even with this on.</p>` : ""}
    </div></div>
  </div>

  <div class="row2" style="align-items:start">
    <div class="panel" data-reveal><header><h2>This server</h2></header><div class="body">
      <dl class="kv">
        <dt>Running as</dt><dd>${esc(st.mode || "local")}</dd>
        <dt>Data collected</dt><dd>${esc(new Date(d.generated).toLocaleString())}
          <span class="muted">(${ago(d.generated)})</span></dd>
        <dt>Collection took</dt><dd>${esc(d.collect_seconds)} seconds</dd>
        ${(S.support || {}).owner ? `<dt>This deployment</dt>
          <dd>Yours. ${info("own", `Reports anybody sends from the Support
            tab arrive in <b>Feedback</b>, in the sidebar, and you are the
            only account that can read or answer them. Whoever set this
            server up is its owner: either the address in
            <code>PATCHVANE_OWNER</code>, or, if nobody said, the first
            account to sign in here.`)}</dd>` : ""}
      </dl>
      ${appearanceBox()}
    </div></div>
  </div>`;
}

/* --------------------------------------------------------------- support

   Two things, and they are two things on purpose. Most of what brings
   somebody here is a question that already has an answer, so the answers
   come first and are searchable; sending a message is underneath, for when
   they do not. A support page that leads with a contact form asks everybody
   to describe their problem to a person before letting them find out it was
   answered years ago.

   Where a message goes is asked after it is written, never before. Being
   made to classify something before describing it is how feature requests
   end up filed as bugs: whoever is typing does not yet know which they are
   writing, and asking first makes them think about the form instead of the
   problem. */

function setSupport() {
  loadSupport();
  const s = S.support || {};
  const found = s.q ? helpSearch(s.q) : [];
  const shown = s.q ? found : HELP;

  return `<div class="panel wide" data-reveal>
    <header><h2>Help</h2>
      <span class="sub">${s.q
        ? found.length
          ? plural(found.length, "answer") + " for \u201c" + esc(s.q) + "\u201d"
          : "nothing matched \u201c" + esc(s.q) + "\u201d"
        : plural(HELP.length, "answer") + ", or search them"}</span></header>
    <div class="body">
      <div class="findrow" style="margin-bottom:16px">
        <div class="findbox">
          <input type="search" id="helpq" data-search="help"
                 value="${esc(s.q || "")}"
                 placeholder="What is not working? A word or two is enough"
                 spellcheck="false" autocomplete="off"
                 ${actv("input", helpTyped)}>
        </div>
        ${s.q ? `<button class="btn" ${act(helpTyped, "")}>Clear</button>` : ""}
      </div>

      ${s.q && !found.length ? `<div class="empty">
        <h3>Nothing here matches that</h3>
        <p>Try a different word, or write it out below and it will reach
        somebody.</p></div>` : helpList(shown, s)}
    </div>
  </div>

  ${feedbackPanel()}`;
}

/* Grouped when the whole list is showing, flat when it is a search result:
   ranked answers put back into topic order are no longer ranked. */
function helpList(items, s) {
  const open = s.open || "";
  const one = (h) => `<div class="qa ${open === h.id ? "on" : ""}">
    <button class="qhead" ${act(helpOpen, h.id)}>
      <span class="caret">\u25BE</span>
      <strong>${esc(h.q)}</strong>
      <span class="spacer"></span>
      <span class="qtopic">${esc(h.topic)}</span>
    </button>
    ${open === h.id ? `<div class="qbody">${md(h.a)}</div>` : ""}
  </div>`;

  if (s.q) return `<div class="qalist">${items.map(one).join("")}</div>`;

  const topics = [];
  for (const h of items) {
    const last = topics[topics.length - 1];
    if (last && last.name === h.topic) last.items.push(h);
    else topics.push({ name: h.topic, items: [h] });
  }
  return topics.map((t) => `<div class="qagroup">
    <h3 class="qagtitle">${esc(t.name)}</h3>
    <div class="qalist">${t.items.map(one).join("")}</div>
  </div>`).join("");
}

/* Every keystroke redraws the answers under the box, which throws the box
   away with them.  render() already knows how to put a search box back
   exactly as it was -- the same caret, the same selection -- so use that
   rather than refocusing by hand afterwards. Doing it by hand is what made
   backspace look broken: focus was restored only if it had somehow
   survived, and the caret was slammed to the end of the line either way,
   so deleting from the middle deleted from the end, or did nothing. */
function helpTyped(value) {
  S.support = Object.assign({}, S.support, { q: value, open: "" });
  /* One answer for one search is a click nobody should have to make. */
  const hits = value ? helpSearch(value) : [];
  if (hits.length === 1) S.support.open = hits[0].id;
  render("help");
}

function helpOpen(id) {
  S.support = Object.assign({}, S.support,
                            { open: (S.support || {}).open === id ? "" : id });
  render();
}

/* The kinds of thing people send.  Asked because the answer changes what
   happens next -- "a number is wrong" is a different job from "this could
   be better" -- and because the owner reading twenty of these needs to be
   able to see the broken ones first. Asked after the writing, not before:
   being made to classify something before describing it is how a feature
   request ends up filed as a bug. */
/* The long label is the one put to somebody choosing between them, where
   the whole sentence is the point.  The short one is for the table the
   owner reads afterwards, where a column of sentences is a column wide
   enough to push what people actually wrote into four words a line. */
const FEEDBACK_KINDS = [
  ["bug", "Something is broken", "\u26A0", "red", "Broken"],
  ["wrong", "A number or status looks wrong", "\u2260", "amber", "Wrong"],
  ["idea", "Something could be better", "\u2726", "purple", "Idea"],
  ["question", "I could not work out how to do something", "?", "blue",
   "Question"],
  ["praise", "Something to say", "\u2661", "green", "Praise"],
];

const FEEDBACK_STATUS = {
  "new": ["Not looked at yet", "grey"],
  "seen": ["Read", "blue"],
  "working": ["Being worked on", "amber"],
  "fixed": ["Done", "green"],
  "known": ["Known, not started", "purple"],
  "wontfix": ["Not going to change", "red"],
  "ask": ["Waiting on you", "cyan"],
};

function fbStatus(k) { return FEEDBACK_STATUS[k] || [k || "unknown", "grey"]; }

function fbKind(k) {
  return FEEDBACK_KINDS.find((x) => x[0] === k) || [k, k, "\u2022", "grey", k];
}

function feedbackPanel() {
  const s = S.support || {};
  const text = (s.text || "").trim();
  const ready = text.length >= 10;
  const kind = s.kind || "";

  const chooser = FEEDBACK_KINDS.map(([id, label, icon, cls]) => `
    <button class="kindbtn ${cls} ${kind === id ? "on" : ""}"
      ${act(pickKind, id)}>
      <span class="ki">${icon}</span>${esc(label)}</button>`).join("");

  return `<div class="panel wide" data-reveal>
    <header><h2>Tell us something</h2>
      <span class="sub">a bug, a wrong number, or anything else</span>
      <div class="spacer"></div>
      ${info("fb", `Everything sent here is written down where the person who
        runs this signs in, so it reaches them whether or not this
        deployment has mail or an issue tracker set up. Your address goes
        with it, so they can come back to you, and you will see what they
        say below.`)}</header>
    <div class="body">
      ${s.sent ? `<div class="sentnote">
        <strong>${esc(s.sent.stored
          ? "Thank you \u2014 that is written down."
          : "Thank you \u2014 that has been passed on.")}</strong>
        <p>${esc(!s.sent.stored
          ? "This deployment could not file it here, so it went straight "
            + "to whoever runs it. Any answer will come by mail rather "
            + "than appearing below."
          : s.sent.told
            ? "It has gone to whoever runs this, and you will hear back here."
            : "It is waiting for whoever runs this, and you will hear back "
              + "here.")}</p>
        ${s.sent.link ? `<a class="btn sm" href="${esc(s.sent.link)}"
          target="_blank" rel="noreferrer">See the issue \u2197</a>` : ""}
        <button class="btn ghost sm" ${act(feedbackAgain)}>Write another</button>
      </div>` : `
      <div class="field">
        <textarea id="fbtext" data-search="fb" rows="5"
          ${actv("input", feedbackTyped)}
          placeholder="What happened, or what would be better?"
          >${esc(s.text || "")}</textarea>
      </div>
      <div class="route ${ready ? "on" : ""}">
        <p class="routeq">${ready
          ? "What kind of thing is it?"
          : "Write a line or two, and this will ask what kind of thing it is."}</p>
        <div class="kinds">${chooser}</div>
        <div class="btnrow">
          <button class="btn primary" ${act(sendFeedback)}
            ${!ready || !kind || s.busy ? "disabled" : ""}>
            ${s.busy ? "Sending\u2026" : "Send it"}</button>
          ${(s.routes || {}).issue && kind === "bug" ? `
            <label class="check"><input type="checkbox"
              ${s.alsoIssue ? "checked" : ""} ${actv("change", toggleIssue)}>
              Also open a public issue in ${esc(s.repo || "the tracker")}</label>`
            : ""}
        </div>
        ${s.error ? `<p class="testline bad">${esc(s.error)}</p>` : ""}
      </div>`}
      ${myReports(s)}
    </div>
  </div>`;
}

/* What this person sent before, and what was said back.  Without it, a
   report is a message dropped into a hole: the only way to find out whether
   anybody looked is to write again. */
function myReports(s) {
  const rows = s.mine || [];
  if (!rows.length) return "";
  return `<div class="answered">
    <h3>What you have sent</h3>
    ${rows.map((r) => {
      const [said, cls] = fbStatus(r.status);
      const answers = (r.answers || []).filter((a) => a.note);
      return `<div class="mrow">
        <div class="mhead">
          <span class="pill ${cls}">${esc(said)}</span>
          <span class="muted">${esc(fbKind(r.kind)[1])}</span>
          <div class="spacer"></div>
          <span class="muted">${ago(r.at)}</span>
        </div>
        <p class="mtext">${esc(r.text)}</p>
        ${answers.map((a) => `<div class="mreply">
          <strong>${esc(fbStatus(a.status)[0])}</strong>
          <p>${esc(a.note)}</p>
          <span class="muted">${ago(a.at)}</span></div>`).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

function pickKind(id) {
  S.support = Object.assign({}, S.support,
                            { kind: (S.support || {}).kind === id ? "" : id });
  render();
}

function toggleIssue(on) {
  S.support = Object.assign({}, S.support, { alsoIssue: on });
  render();
}

function feedbackTyped(value) {
  const was = ((S.support || {}).text || "").trim().length >= 10;
  const now = (value || "").trim().length >= 10;
  S.support = Object.assign({}, S.support, { text: value, error: "" });
  /* Only redraw when the answer to "can this be sent yet" changes.  On every
     keystroke it would rebuild the box being typed into. */
  if (was === now) return;
  render("fb");
}

function feedbackAgain() {
  S.support = Object.assign({}, S.support,
                            { sent: null, text: "", kind: "", error: "" });
  render();
}

async function sendFeedback() {
  const s = S.support || {};
  const text = (s.text || "").trim();
  if (text.length < 10 || !s.kind) return;
  S.support = Object.assign({}, s, { busy: true, error: "" });
  render();
  try {
    const r = await post("/api/support/feedback", {
      text, kind: s.kind, where: S.view,
      route: s.alsoIssue && s.kind === "bug" ? "issue" : "" });
    const body = await r.json();
    S.support = Object.assign({}, S.support, { busy: false });
    if (!body.ok) {
      S.support.error = body.error || "That did not go through.";
    } else {
      S.support.sent = body;
      S.support.text = "";
      S.support.kind = "";
      /* Straight into their own list, so "is anybody looking at this" has
         an answer from the moment it is sent. */
      S.support.asked = false;
      loadSupport();
    }
  } catch (e) {
    S.support = Object.assign({}, S.support, { busy: false,
      error: "Could not reach the dashboard." });
  }
  render();
}

/* Which ways out this deployment actually has, asked once when the tab is
   first opened rather than offered and then found not to work. */
async function loadSupport() {
  /* Marked as asked before it is asked, so a deployment where this fails
     does not refetch on every keystroke in the search box. */
  if ((S.support || {}).asked) return;
  S.support = Object.assign({}, S.support, { asked: true });
  try {
    const r = await fetch("/api/support", { cache: "no-store" });
    const body = await r.json();
    S.support = Object.assign({}, S.support,
                              { routes: body.routes || {}, repo: body.repo,
                                owner: !!body.owner, mine: body.mine || [],
                                waiting: body.waiting || 0 });
    render();
  } catch (e) { /* the help still works */ }
}

const ZONE_NAME = {
  code: "code and patches", writing: "drafting replies",
  reasoning: "working things out", summary: "counting and listing",
  long: "reading a lot at once",
};

function setAI() {
  const st = S.status;
  const list = S.providers || [];
  const ready = list.filter((p) => p.ready);

  const cards = list.map((p, i) => {
    const open = S.keyOpen === p.id;
    /* A deployment-specific address that nobody has filled in yet: the key
       alone will not reach anything. */
    const unset = p.where && /YOUR-|example\.com/.test(p.endpoint || "");
    return { id: p.id, ready: p.ready, html:
      `<div class="provider ${p.ready ? "on" : ""}" data-reveal style="--i:${i}">
      <div class="ph">
        <span class="pdot ${p.ready ? "on" : ""}"></span>
        <div class="pn"><strong>${esc(p.label)}</strong>
          <i>${p.good_at.map((g) => esc(ZONE_NAME[g] || g)).join(", ") || "general"}</i></div>
        <div class="spacer"></div>
        ${p.ready
          ? `<span class="pill green">ready</span>`
          : `<span class="pill grey">no key</span>`}
      </div>
      <dl class="kv tight2">
        <dt>Model</dt><dd>${modelChoice(p)}</dd>
        ${p.ready ? `<dt>Key from</dt><dd>${esc(p.source)}</dd>` : ""}
        <dt>Get a key</dt><dd class="mono">${esc(p.where)}</dd>
      </dl>
      ${unset ? `<p class="hint">This provider gives every deployment its own
        address, and this server has not been pointed at one, so a key added
        here will not reach anything until it is.</p>` : ""}
      ${S.keyTest && S.keyTest.id === p.id
        ? `<p class="testline ${S.keyTest.pending ? "waiting"
            : S.keyTest.ok ? "ok" : "bad"}">${esc(S.keyTest.msg)}</p>`
        : ""}
      ${open ? `
        <div class="field">
          <input type="password" data-key="${p.id}" placeholder="${
            p.ready ? "paste a new key to replace the current one"
                    : "paste the key from " + esc(p.where)}">
        </div>
        ${st.can_store_key === false
          ? `<p class="hint">This deployment will not write keys to disk, so
             it will live in memory only until the server restarts.</p>`
          : `<label class="check"><input type="checkbox" data-remember="${p.id}"
             checked> Remember this key</label>`}
        <div class="btnrow">
          <button class="btn primary sm" ${act(saveKey, p.id)}>Save</button>
          <button class="btn ghost sm" ${act(toggleKey, "")}>Cancel</button>
        </div>`
        : `<div class="btnrow">
          <button class="btn sm" ${act(toggleKey, p.id)}>${
            p.ready ? "Replace key" : "Add key"}</button>
          ${p.ready ? `<button class="btn ghost sm" ${act(testKey, p.id)}>Test</button>` : ""}
          ${p.ready
            ? `<button class="btn ghost sm" ${act(clearKey, p.id)}>Remove</button>` : ""}
        </div>`}
    </div>` };
  });

  /* Twenty cards at once is a wall.  What is already working comes first,
     and the rest stay folded away until someone goes looking. */
  const done = cards.filter((c) => c.ready).map((c) => c.html).join("");
  const rest = cards.filter((c) => !c.ready);
  const open = S.allModels || S.keyOpen;

  return `<div class="panel wide" data-reveal>
    <header><h2>Models the assistant can use</h2>
      <span class="sub">${ready.length
        ? `${plural(ready.length, "provider")} ready, ${rest.length} more available`
        : `none set up yet, ${rest.length} to choose from`}</span>
      <div class="spacer"></div>
      ${info("keys", `Add a key for any of these and the assistant can use
        it. One is enough. Every question goes out with a digest of what this
        dashboard collected: totals, per tree numbers, landed commits, open
        threads and review tags. Reviewer addresses are masked before they
        leave. No mail bodies and no credentials go with them.`)}
      ${ready.length ? `<button class="btn sm" ${act(askAI)}>Open the assistant</button>` : ""}
    </header>
    <div class="body">
      ${done ? `<div class="providers">${done}</div>` : ""}
      ${rest.length ? `
        <button class="disclose ${open ? "on" : ""}" ${act(toggleAllModels)}>
          <span class="caret">\u25BE</span>
          ${open ? "Hide" : "Show"} the other ${rest.length}</button>
        ${open ? `<div class="providers">${
          rest.map((c) => c.html).join("")}</div>` : ""}` : ""}
    </div>
  </div>

  ${readingPanel()}

  <div class="row2" style="align-items:start">
    <div class="panel" data-reveal><header><h2>How Auto picks</h2>
      <div class="spacer"></div>
      ${info("auto-pick", `On Auto the question is read for what kind of
        question it is, and the models suited to that go first. If one is
        rate limited or overloaded, the next takes it and the answer says
        who ended up replying. Pick a model by name in the assistant to
        override this; it still falls back if that one is down. Greyed out
        below means no key, so it is skipped.`)}</header>
      <div class="body">
      <dl class="kv">
        ${Object.entries(ZONE_NAME).map(([z, name]) => `
          <dt>${esc(name)}</dt>
          <dd>${(S.zones && S.zones[z] ? S.zones[z] : [])
            .map((id) => {
              const p = list.find((x) => x.id === id);
              return p ? `<span class="pill ${p.ready ? "green" : "grey"}">${
                esc(p.label)}</span>` : "";
            }).join(" ") || `<span class="muted">\u2014</span>`}</dd>`).join("")}
      </dl>
    </div></div>

    <div class="panel" data-reveal><header><h2>What you can ask</h2></header>
      <div class="body">
      <ul class="asklist">
        ${SUGGESTIONS.map((s) => `<li ${act(askAI, s)}>${esc(s)}</li>`).join("")}
      </ul>
    </div></div>
  </div>`;
}

/* Most of a patch's status is a fact: a commit in a tree, or a state
   somebody set in patchwork.  What is left is a thread of English, and this
   says how well the last collection managed to read it. */
function readingPanel() {
  const st = S.data.ai_states;
  if (!st) return "";
  const read = work().filter((p) => p.state_by_ai).length;
  const firm = work().length - read;

  return `<div class="panel wide" data-reveal>
    <header><h2>Reading the threads</h2>
      <span class="sub">where a status came from</span>
      <div class="spacer"></div>
      ${info("reading", `A patch in a tree, or one somebody marked in
        patchwork, is a recorded fact and is never second-guessed. The rest
        is a maintainer writing in English, and phrases like "I've taken
        this" or "send it via net-next instead" are easy to misread. On the
        last collection a model was asked about those, and only those.`)}
    </header>
    <div class="body">
      <div class="stats3">
        <div><b>${firm}</b><span>from a commit or patchwork</span></div>
        <div><b class="${read ? "ai" : ""}">${read}</b>
          <span>read out of the replies</span></div>
        <div><b>${st.asked || 0}</b><span>${st.asked
          ? "questions it took to do that"
          : "asked last time, the rest was remembered"}</span></div>
      </div>
      ${st.error
        ? `<p class="testline bad">The last collection could not ask:
           ${esc(st.error)} Those threads kept the status worked out from
           their text.</p>`
        : read
          ? `<p class="hint">Those carry a <span class="readmark">read</span>
             mark in the patch list, so a reading is never mistaken for a
             record.</p>`
          : `<p class="hint">Nothing needed a second reading last time.</p>`}
    </div>
  </div>`;
}

/* Which model this provider should use.

   Without a key there is no answer to give.  A name here would be this
   dashboard's opinion from whenever it was last edited, and providers retire
   a model the week the next one ships -- so what used to sit next to "no
   key" was often a model that no longer existed, stated as though it were
   settled.  It says what will happen instead.

   With a key it is a fact: the list came from the provider when the key was
   saved, and the one in the box is the most capable of them.  The rest are
   fetched on demand, because twenty providers' catalogues at once is a lot
   of requests for a page nobody may scroll. */
function modelChoice(p) {
  if (!p.ready) {
    /* Unless this server pinned one, which is a decision somebody made on
       purpose rather than a name nobody checked, so it is shown and said. */
    return p.pinned
      ? `<span class="mono">${esc(p.model)}</span>
         <span class="hint tiny">pinned by this server</span>`
      : `<span class="muted">chosen when you add a key</span>`;
  }

  const got = (S.modelList || {})[p.id];
  if (!got) {
    return `${p.model
        ? `<span class="mono">${esc(p.model)}</span>`
        : `<span class="muted">not chosen yet</span>`}
      <button class="link sm" ${act(loadModels, p.id)}>change</button>`;
  }
  if (got.loading) return `<span class="muted">reading the list\u2026</span>`;
  if (got.error) {
    return `<span class="mono">${esc(p.model)}</span>
      <span class="testline bad">${esc(got.error)}</span>
      <button class="link sm" ${act(loadModels, p.id)}>try again</button>`;
  }

  /* Arrives ranked, so the list opens on the one worth having.  A model
     they are already on that the provider no longer lists still belongs in
     the box, or changing anything else would silently move them off it. */
  const names = got.models || [];
  const known = p.model && !names.includes(p.model)
    ? [p.model].concat(names) : names;
  return `<select class="sel sm" ${actv("change", pickProviderModel, p.id)}>
      ${known.map((m) => `<option value="${esc(m)}" ${
        m === p.model ? "selected" : ""}>${esc(m)}${
        m === got.best ? " \u2014 best on this key" : ""}</option>`).join("")}
    </select>
    <p class="hint tiny">${plural(names.length, "model")} on this key,
    strongest first.${got.best && got.best !== p.model
      ? ` <button class="link" ${act(pickProviderModel, p.id, got.best)}>Use
        ${esc(got.best)}</button>` : ""}</p>
    ${got.spares && got.spares.length
      ? `<p class="hint tiny">If this one runs out for the day the assistant
         falls back to ${got.spares.map(esc).join(", ")}.</p>` : ""}`;
}

async function loadModels(pid) {
  S.modelList = S.modelList || {};
  S.modelList[pid] = { loading: true };
  render();
  try {
    const r = await fetch("/api/ai/models?provider=" + encodeURIComponent(pid),
                          { cache: "no-store" });
    const body = await r.json();
    S.modelList[pid] = body.ok
      ? { models: body.models || [], spares: body.spares || [],
          best: body.best || "" }
      : { error: body.error || "Could not read the list." };
  } catch (e) {
    S.modelList[pid] = { error: "Could not reach the dashboard." };
  }
  render();
}

/* Remember the choice, so it survives a restart and the collector uses it
   too. */
async function pickProviderModel(pid, model) {
  const was = (S.providers.find((x) => x.id === pid) || {}).model;
  if (!model || model === was) return;
  try {
    const r = await post("/api/ai/model", { provider: pid, model: model });
    const body = await r.json();
    if (!body.ok) { toast(body.error || "Could not save that.", "bad"); return; }
    S.providers = S.providers.map(
      (x) => (x.id === pid ? Object.assign({}, x, { model: model }) : x));
    toast(label(pid) + " will use " + model, "ok");
  } catch (e) {
    toast("Could not reach the dashboard.", "bad");
  }
  render();
}

function toggleAllModels() { S.allModels = !S.allModels; render(); }

function toggleKey(id) {
  S.keyOpen = S.keyOpen === id ? "" : id;
  S.keyTest = null;
  render();
}

function setSources() {
  const s = S.data.sources || {};
  const meta = {
    lore: ["lore.kernel.org", "Every message you posted and every reply that came back."],
    patchwork: ["patchwork.kernel.org", "The state a maintainer set, and CI results."],
    korg: ["git.kernel.org", "Whether a commit reached mainline, linux-next or a maintainer tree."],
    cache: ["local cache", "Responses kept on disk so a refresh stays cheap."],
  };
  const cards = Object.entries(meta).map(([key, [title, blurb]], i) => {
    const src = s[key] || {};
    const ok = src.ok !== false && !src.error;
    return `<div class="panel" data-reveal style="--i:${i}">
      <header><h2>${esc(title)}</h2><div class="spacer"></div>
        ${info("src-" + key, esc(blurb))}
        <span class="pill ${ok ? "green" : "red"}">${ok ? "connected" : "unavailable"}</span></header>
      <div class="body">
        <dl class="kv" style="grid-template-columns:150px 1fr">
          ${Object.entries(src).filter(([k]) => k !== "ok").map(([k, v]) =>
            `<dt>${esc(k.replace(/_/g, " "))}</dt>
             <dd>${esc(Array.isArray(v) ? v.join(", ") : v)}</dd>`).join("")}
        </dl></div></div>`;
  }).join("");
  return `<div class="row2" style="align-items:start">${cards}</div>`;
}

/* ------------------------------------------------------------- discover */

/* The two questions that are not about your own patches: what the public
   archives hold under somebody else's address, and who a patch touching a
   given file is supposed to go to.  Both read the same places the collector
   reads, and neither of them needs anything private of anybody's. */

S.find = { q: "", author: null, busy: false, error: "", poll: 0,
           mq: "", maint: null, mbusy: false, merror: "" };

function viewDiscover() {
  return tabs("find", [
    ["people", "An author", findAuthorView],
    ["send", "Who to send to", findSendView],
  ]);
}

function findTyped(which, value) { S.find[which] = value; }

function searchRow(which, go, value, placeholder, busy, label, extra) {
  return `<div class="findrow" data-reveal>
    <div class="findbox">
      <input type="search" data-find="${which}" value="${esc(value)}"
             placeholder="${esc(placeholder)}" spellcheck="false"
             autocomplete="off" autocapitalize="off"
             ${actv("input", findTyped, which)}>
      ${extra || ""}
    </div>
    <button class="btn primary" ${act(go)} ${busy ? "disabled" : ""}>${
      busy ? "Looking\u2026" : esc(label)}</button>
  </div>`;
}

/* ------------------------------------------- who they might mean

   A name is what somebody has in front of them on a patch; an address is
   what they would have to go and look up first. So the box takes either,
   and offers what it knows while they type.

   The list is redrawn in place rather than through render(), because
   rebuilding the view under a search box takes the cursor and the selection
   with it, and a suggestion list that resets what you are typing is worse
   than no suggestion list. */

function findSuggestBox() {
  const list = S.find.people || [];
  if (!S.find.sugOpen || !list.length) return `<div id="findsug"></div>`;
  return `<div id="findsug" class="sugmenu">${list.map((w, i) => `
    <button class="${i === S.find.sugAt ? "on" : ""}"
      ${act(findPick, w.email)}>
      <strong>${esc(w.name || w.email)}</strong>
      <i>${esc(w.name ? w.email : "")}${w.from === "MAINTAINERS"
        ? (w.name ? " \u00b7 " : "") + "in MAINTAINERS" : ""}</i>
    </button>`).join("")}</div>`;
}

function drawSuggest() {
  const box = document.getElementById("findsug");
  if (box) box.outerHTML = findSuggestBox();
}

/* One request in flight and one queued, no more: this fires on every
   keystroke, and the answer to "hema" is worthless once "hemanth" is typed. */
function findSuggest(value) {
  S.find.q = value;
  S.find.sugAt = -1;
  clearTimeout(S.find.sugTimer);
  if ((value || "").trim().length < 2) {
    S.find.people = [];
    S.find.sugOpen = false;
    drawSuggest();
    return;
  }
  S.find.sugTimer = setTimeout(async () => {
    const asked = value;
    try {
      const r = await fetch("/api/discover/people?q=" + encodeURIComponent(asked),
                            { cache: "no-store" });
      const body = await r.json();
      /* They have typed on since this went out, so it is about a different
         question now and its answer would flicker past on the way to the
         right one. */
      if (S.find.q !== asked) return;
      S.find.people = body.people || [];
      S.find.sugOpen = true;
      drawSuggest();
    } catch (e) { /* the box still works without help */ }
  }, 180);
}

function findPick(email) {
  S.find.q = email;
  S.find.sugOpen = false;
  S.find.people = [];
  const box = document.querySelector("[data-find='q']");
  if (box) box.value = email;
  drawSuggest();
  findGo();
}

/* Down, up and Enter through the list, because a suggestion list that can
   only be reached with the mouse is half a suggestion list. */
function findKeys(e) {
  const list = S.find.people || [];
  if (!S.find.sugOpen || !list.length) {
    if (e.key === "Enter") { e.preventDefault(); findGo(); }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    S.find.sugAt = (S.find.sugAt + step + list.length + 1) % (list.length + 1) - 1;
    if (S.find.sugAt < 0) S.find.sugAt = list.length - 1;
    drawSuggest();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (S.find.sugAt >= 0) findPick(list[S.find.sugAt].email);
    else { S.find.sugOpen = false; drawSuggest(); findGo(); }
  } else if (e.key === "Escape") {
    S.find.sugOpen = false;
    drawSuggest();
  }
}

/* ---------------------------------------------------------- an author */

async function findGo() {
  const q = (S.find.q || "").trim();
  if (!q) { toast("Type a name or an email address first.", "bad"); return; }
  S.find.busy = true;
  S.find.error = "";
  S.find.choices = [];
  S.find.sugOpen = false;
  render();
  const r = await fetch("/api/discover/author?email=" + encodeURIComponent(q),
                        { cache: "no-store" });
  const out = await r.json().catch(() => ({}));
  S.find.busy = false;
  if (!out.ok) {
    S.find.author = null;
    S.find.error = out.error || "That lookup did not work. Try again.";
    /* A name that belongs to more than one person: none was picked, because
       showing a stranger's record under the name somebody typed is worse
       than asking which of them they meant. */
    S.find.choices = out.choices || [];
  } else {
    S.find.author = out;
  }
  render();
  findWatch();
}

/* The maintainer tree sweep runs behind the page, so while it is going the
   answer is asked for again every few seconds.  One timer, ever. */
function findWatch() {
  const a = S.find.author;
  if (!a || !a.deep || a.deep.state !== "running") return;
  if (S.find.poll) return;
  S.find.poll = setTimeout(async () => {
    S.find.poll = 0;
    const who = (S.find.author || {}).email;
    if (!who || S.view !== "discover") return;
    const r = await fetch("/api/discover/author?email=" + encodeURIComponent(who),
                          { cache: "no-store" });
    const out = await r.json().catch(() => ({}));
    if (out.ok && S.find.author && S.find.author.email === out.email) {
      S.find.author = out;
      render();
      findWatch();
    }
  }, 5000);
}

async function findDeep() {
  const who = (S.find.author || {}).email;
  if (!who) return;
  S.find.author.deep = { state: "running", done: 0,
                         total: (S.find.author.deep || {}).total || 80 };
  render();
  const r = await post("/api/discover/deep", { email: who });
  const out = await r.json().catch(() => ({}));
  if (out.deep) S.find.author.deep = out.deep;
  render();
  findWatch();
}

function findAuthorView() {
  const f = S.find;
  const head = searchRow("q", findGo, f.q,
                         "a name, or an address they send patches from",
                         f.busy, "Look them up", findSuggestBox());
  const blurb = `<p class="hint" style="margin:0 0 14px">Counted from
    patchwork and git.kernel.org, which is what everybody can see. Nothing
    here comes from anyone's dashboard.</p>`;

  if (f.busy && !f.author) {
    return head + blurb + `<div class="panel wide"><div class="body">
      <div class="thwait"><span class="spin"></span>
      Reading patchwork and git.kernel.org\u2026</div></div></div>`;
  }
  if (f.error) {
    return head + blurb + `<div class="panel wide"><div class="body">
      <div class="empty"><h3>${esc(f.error)}</h3>
      ${(f.choices || []).length ? `<div class="whichone">${
        f.choices.map((w) => `<button class="btn sm" ${act(findPick, w.email)}>
          <strong>${esc(w.name || w.email)}</strong>
          <span>${esc(w.name ? w.email : "")}</span></button>`).join("")}
        </div>` : ""}</div></div></div>`;
  }
  if (!f.author) {
    return head + blurb + `<div class="panel wide"><div class="body">
      <div class="empty tall">
        <h3>Look up anybody who posts patches</h3>
        <p>By name or by address. How much they have sent, how much was
        taken, what is queued in linux-next and what has reached Linus'
        tree &mdash; with the commit and the exact tag it first appeared
        in.</p>
      </div></div></div>`;
  }
  return head + authorResult(f.author);
}

function authorResult(a) {
  const c = a.counts;
  const deep = a.deep || {};
  const n = (v) => (v < 0 ? "\u2014" : v);
  const gone = "not reachable just now";
  const cards = [
    ["blue", "Patches sent", n(c.submitted),
     a.sources.patchwork ? "as patchwork counts them" : gone],
    ["purple", "Accepted", n(c.accepted),
     a.sources.patchwork ? "a maintainer took it" : gone],
    ["cyan", "Queued in linux-next", n(c.in_next),
     a.sources.git ? "not in mainline yet" : gone],
    ["green", "In Linus' tree",
     c.merged < 0 ? "\u2014" : c.merged + (a.more.merged ? "+" : ""),
     !a.sources.git ? gone
       : a.more.merged ? "the most recent " + c.merged : "merged upstream"],
  ].map(([cls, label, v, sub], i) =>
    /* A plain value rather than an animated counter: these can read "200+"
       or a dash, and a counter can only count to a number. */
    `<div class="kpi ${cls} flat" data-reveal style="--i:${i}">
      <div class="label">${esc(label)}</div>
      <span class="value">${esc(String(v))}</span>
      <div class="sub">${esc(sub)}</div></div>`).join("");

  const notes = (a.notes || []).length
    ? `<p class="hint" style="margin:-4px 0 14px">${
        a.notes.map(esc).join(" &middot; ")}</p>`
    : "";

  return `<div class="kpis four">${cards}</div>${notes}`
    + `<p class="hint" style="margin:0 0 14px">
       ${a.name ? `<strong>${esc(a.name)}</strong> &middot; ` : ""}
       ${esc(a.email)}${a.resolved
         ? ` <span class="muted">(what &ldquo;${esc(a.asked)}&rdquo; commits under)</span>`
         : ""} &middot;
       <a href="${esc(a.lore)}" target="_blank"
       rel="noreferrer">their posts on lore \u2197</a> &middot;
       <a href="${esc(a.patchwork)}" target="_blank" rel="noreferrer">on
       patchwork \u2197</a> &middot; answered in ${esc(String(a.seconds))}s</p>`
    + mergedTable(a) + treeSweep(a, deep) + queuedPanel(a)
    + pwTable(a, "taken", "Accepted by a maintainer",
              "patchwork says it was applied; the commit may not have "
              + "surfaced in a public tree yet")
    + pwTable(a, "posted", "Everything they sent",
              "every patch patchwork has from this address, whatever "
              + "became of it");
}

/* Patchwork words a state its own way and there are more of them than this
   page has colours for, so they are read back into the same vocabulary the
   rest of the site uses. */
const PW_STATE = {
  "new": "awaiting", "under-review": "under-review", "rfc": "under-review",
  "needs-review-ack": "needs-ack", "accepted": "accepted",
  "mainlined": "merged", "queued": "queued",
  "awaiting-upstream": "awaiting-upstream", "superseded": "superseded",
  "changes-requested": "changes-requested", "rejected": "rejected",
  "not-applicable": "not-applicable", "handled-elsewhere": "handled-elsewhere",
  "deferred": "deferred",
};

function pwState(r) { return PW_STATE[r.state] || r.state || "awaiting"; }

/* The two patchwork numbers, as lists.  They were counts and nothing else,
   which is an odd place to stop when the tree panels below name every
   commit one by one. */
function pwTable(a, which, title, blurb) {
  const rows = a[which] || [];
  if (!a.sources.patchwork) {
    return `<div class="panel wide" data-reveal>
      <header><h2>${esc(title)}</h2></header><div class="body"><div class="empty">
      <h3>patchwork did not answer</h3>
      <p>So there is no list to show here.</p></div></div></div>`;
  }
  if (!rows.length) {
    return `<div class="panel wide" data-reveal>
      <header><h2>${esc(title)}</h2></header><div class="body"><div class="empty">
      <h3>Nothing under this address</h3>
      <p>Patchwork only holds what was sent to a list it follows, so work
      posted elsewhere will not be here.</p></div></div></div>`;
  }
  const total = a.counts[which === "taken" ? "accepted" : "submitted"];
  return grid("find" + which, rows, [
    { key: "subject", label: "Subject", cls: "subject", width: "46%",
      csv: (r) => r.subject,
      /* Patchwork records the commit for anything that landed, so those
         open here like every other commit on the site. */
      render: (r) => (r.commit
        ? `<button class="link" ${act(openCommit, r.commit, "mainline")}
             title="Read this commit">${mark(r.subject)}</button>`
        : mark(r.subject)) },
    { key: "state", label: "Status", sort: (r) => state(pwState(r)).rank,
      csv: (r) => state(pwState(r)).label,
      render: (r) => pill(pwState(r)) },
    { key: "project", label: "List", sort: (r) => r.list || r.project,
      csv: (r) => r.project,
      render: (r) => `<span class="nowrap muted">${mark(r.list || r.project)}</span>` },
    { key: "date", label: "Sent",
      render: (r) => `<span class="nowrap muted">${esc(r.date)}</span>` },
  ], {
    title,
    subtitle: total > rows.length
      ? `the ${rows.length} most recent of ${total}` : blurb,
    placeholder: "Search a subject\u2026",
    searchIn: (r) => [r.subject, r.project, r.list, r.state].join(" "),
    fields: { state: (r) => pwState(r), list: (r) => r.list,
              sub: (r) => subsystem(r.subject), date: (r) => r.date },
    filters: [
      { key: "state", all: "Any status",
        values: (rs) => countedValues(rs, (r) => pwState(r),
                                      (k) => state(k).label,
                                      (a2, b2) => state(a2).rank - state(b2).rank),
        match: (r, v) => pwState(r) === v },
      { key: "sub", all: "Any subsystem",
        values: (rs) => countedValues(rs, (r) => subsystem(r.subject),
                                      (k) => k + "/"),
        match: (r, v) => subsystem(r.subject) === v },
      { key: "list", all: "Any list",
        values: (rs) => countedValues(rs, (r) => r.list || r.project),
        match: (r, v) => (r.list || r.project) === v },
    ],
    groups: [{ key: "state", label: "by status", of: (r) => state(pwState(r)).label },
             { key: "list", label: "by list", of: (r) => r.list || r.project },
             { key: "sub", label: "by subsystem", of: (r) => subsystem(r.subject) + "/" }],
    rowKey: (r) => r.url || r.subject,
    sort: "date", dir: "desc", per: 15,
  });
}

function mergedTable(a) {
  if (!a.sources.git) {
    return `<div class="panel wide" data-reveal><header><h2>In Linus' tree</h2>
      </header><div class="body"><div class="empty">
      <h3>git.kernel.org did not answer</h3>
      <p>So there is no list to show. This says nothing about whether their
      patches landed &mdash; only that the place that knows could not be
      reached. Try again in a moment.</p></div></div></div>`;
  }
  if (!a.merged.length) {
    return `<div class="panel wide" data-reveal><header><h2>In Linus' tree</h2>
      </header><div class="body"><div class="empty">
      <h3>Nothing under this address in mainline</h3>
      <p>Which is not the same as nothing landed: a patch applied by a
      maintainer keeps the author line it was posted with, so a different
      address on the Signed-off-by would be counted there and not
      here.</p></div></div></div>`;
  }
  return grid("findmerged", a.merged, [
    /* The commit opens here rather than on git.kernel.org: reading three of
       them should not be three tabs and three page loads.  The tree is
       named rather than left to default, because act() hands the element
       and the event on to whatever it calls, so an argument left off here
       would arrive as a DOM node where the tree should be. */
    { key: "short", label: "Commit", cls: "mono nowrap", csv: (r) => r.short,
      render: (r) => `<button class="link mono"
        ${act(openCommit, r.commit, "mainline")}
        title="Read this commit">${mark(r.short)}</button>` },
    { key: "subject", label: "Subject", cls: "subject", width: "46%",
      csv: (r) => r.subject,
      render: (r) => `<button class="link"
        ${act(openCommit, r.commit, "mainline")}
        title="Read this commit">${mark(r.subject)}</button>` },
    /* The exact tag, release candidates included, because "v7.4-rc1" is the
       answer and "v7.4" is only where it ends up.  Both are here: the
       numbered release is the one somebody installs. */
    { key: "tag", label: "First in", sortable: true,
      csv: (r) => r.tag,
      render: (r) => r.tag
        ? `<span class="pill ${r.shipped ? "green" : "cyan"}"
             title="${r.shipped
               ? "the first tag containing it; shipped in " + esc(r.release)
               : "merged since the last release, so this is the tag it is "
                 + "due in"}">${esc(r.tag)}${r.shipped ? "" : " (due)"}</span>${
           r.release && r.release !== r.tag
             ? `<span class="muted"> in ${esc(r.release)}</span>` : ""}`
        : `<span class="muted">\u2014</span>` },
    { key: "date", label: "Merged",
      render: (r) => `<span class="nowrap muted">${esc(r.date)}</span>` },
  ], {
    title: "In Linus' tree",
    subtitle: a.more.merged
      ? "the " + a.merged.length + " most recent; there are more"
      : a.merged.length + " commits",
    placeholder: "Search a commit or a subject\u2026",
    searchIn: (r) => [r.subject, r.short, r.tag, r.release].join(" "),
    fields: { tag: (r) => r.tag, release: (r) => r.release,
              sub: (r) => subsystem(r.subject), date: (r) => r.date },
    filters: [
      byColumn("release", "Any release", (r) => r.release || "not released yet"),
      subsystemFilter(),
      byColumn("year", "Any year", (r) => (r.date || "").slice(0, 4)),
    ],
    groups: [{ key: "release", label: "by release", of: (r) => r.release || "\u2014" },
             { key: "sub", label: "by subsystem", of: (r) => subsystem(r.subject) + "/" }],
    rowKey: (r) => r.commit,
    sort: "date", dir: "desc", per: 15,
  });
}

function queuedPanel(a) {
  if (!a.sources.git || !a.in_next.length) return "";
  return `<div class="panel wide" data-reveal>
    <header><h2>Waiting in linux-next</h2><div class="spacer"></div>
      <span class="pill cyan">${a.counts.in_next}</span></header>
    <div class="body">
      <p class="hint" style="margin-top:0">Queued for a merge window and not
      in mainline yet.</p>
      <ul class="asklist plain">${a.in_next.map((c) =>
        `<li><button class="link mono" ${act(openCommit, c.commit, "linux-next")}
           >${esc(c.short)}</button>
           <button class="link" ${act(openCommit, c.commit, "linux-next")}
           >${esc(c.subject)}</button>
           <span class="muted">${esc(c.date)}</span></li>`).join("")}</ul>
    </div></div>`;
}

function treeSweep(a, deep) {
  /* The sweep works out what is waiting by subtracting what is already in
     mainline, so without mainline there is nothing it could honestly say. */
  if (!a.sources.git) return "";
  const body = () => {
    if (deep.state === "running") {
      const done = deep.done || 0, total = deep.total || 80;
      return `<p class="hint" style="margin-top:0">Asking each maintainer
        tree in turn. git.kernel.org takes its time over an author search,
        so this runs behind the page &mdash; the rest of it still works.</p>
        <div class="prog"><div class="fill" style="width:${
          pct(done, total)}"></div></div>
        <p class="hint">${done} of ${total} trees</p>`;
    }
    if (deep.state === "done") {
      if (!deep.trees.length) {
        return `<p class="hint" style="margin-top:0">Nothing of theirs is
          sitting in a maintainer tree right now. Anything taken has already
          moved on to linux-next or to mainline.</p>`;
      }
      return `<p class="hint" style="margin-top:0">Taken by a maintainer and
        not yet in mainline. Checked ${esc(ago(deep.at))}.</p>`
        + `<table class="plain"><thead><tr><th>Tree</th><th>Waiting</th>
           <th>Also in next</th><th>Newest</th></tr></thead><tbody>`
        + deep.trees.map((t) => `<tr class="main">
            <td><span class="pill blue">${esc(t.tree)}</span></td>
            <td>${t.count}</td><td class="muted">${t.in_next}</td>
            <td class="muted nowrap">${esc(t.newest)}</td></tr>
            <tr class="sub"><td colspan="4"><div class="sub2">${
              t.commits.slice(0, 4).map((c) =>
                `${sha({ commit: c.commit, short: c.short, tree: t.tree })}
                 <button class="link" ${act(openCommit, c.commit, t.tree)}
                 >${esc(c.subject)}</button>`)
                .join("<br>")}</div></td></tr>`).join("")
        + `</tbody></table>`;
    }
    return `<p class="hint" style="margin-top:0">There are ${
      deep.total || 80} maintainer trees on git.kernel.org. Asking each one
      whether it is holding their work takes a few minutes, so it is not
      done unless you ask for it. The answer is kept for six hours and
      shared, so the next person to look costs nothing.</p>
      <div class="btnrow"><button class="btn" ${act(findDeep)}>Check the
      maintainer trees</button></div>`;
  };
  return `<div class="panel wide" data-reveal>
    <header><h2>In a maintainer tree</h2><div class="spacer"></div>
      ${deep.state === "done"
        ? `<span class="pill blue">${deep.count}</span>` : ""}
    </header><div class="body">${body()}</div></div>`;
}

/* ------------------------------------------------------ who to send to */

async function findSend() {
  const q = (S.find.mq || "").trim();
  if (!q) { toast("Type a file path or a subsystem first.", "bad"); return; }
  S.find.mbusy = true;
  S.find.merror = "";
  render();
  const r = await fetch("/api/discover/maintainers?q=" + encodeURIComponent(q),
                        { cache: "no-store" });
  const out = await r.json().catch(() => ({}));
  S.find.mbusy = false;
  if (!out.ok) {
    S.find.maint = null;
    S.find.merror = out.error || "That lookup did not work.";
  } else {
    S.find.maint = out;
  }
  render();
}

function findSendView() {
  const f = S.find;
  const head = searchRow("mq", findSend, f.mq,
                         "drivers/gpu/drm/amd/  or  net/ipv4/tcp.c  or  btrfs",
                         f.mbusy, "Find them");
  const blurb = `<p class="hint" style="margin:0 0 14px">Read straight out of
    MAINTAINERS in mainline, by the same rules
    <code>scripts/get_maintainer.pl</code> uses. A path out of a diff works
    as it is, <code>a/</code> and all.</p>`;

  if (f.merror) {
    return head + blurb + `<div class="panel wide"><div class="body">
      <div class="empty"><h3>${esc(f.merror)}</h3></div></div></div>`;
  }
  if (!f.maint) {
    return head + blurb + `<div class="panel wide"><div class="body">
      <div class="empty tall">
        <h3>Who should receive this patch?</h3>
        <p>Give it a file you changed and it names the maintainers to
        address, the reviewers and lists to copy, whether anybody is
        actually looking after that corner, and which tree it goes
        through.</p>
      </div></div></div>`;
  }
  return head + sendResult(f.maint);
}

function addrLine(list) {
  return list.map((p) => p.name ? `${p.name} <${p.email}>` : p.email)
             .join(", ");
}

function people(list, kind) {
  if (!list.length) return "";
  return `<div class="sendbox">
    <div class="sendhead"><b>${esc(kind)}</b>
      <button class="link" ${act(copyText, addrLine(list))}>copy</button></div>
    <ul class="asklist plain">${list.map((p) => `<li>${
      p.list ? `<span class="pill grey">list</span> ` : ""}${
      p.name ? `<b>${esc(p.name)}</b> ` : ""}<span class="mono">${
      esc(p.email)}</span>${p.note
        ? ` <span class="tag">${esc(p.note)}</span>` : ""}</li>`).join("")}</ul>
  </div>`;
}

function sendResult(m) {
  if (!m.sections.length) {
    return `<div class="panel wide"><div class="body"><div class="empty">
      <h3>Nothing in MAINTAINERS claims that</h3>
      <p>${m.path ? `No section lists <code>${esc(m.path)}</code>.`
                  : `No subsystem is named after "${esc(m.query)}".`}
      Try a directory above it, or a word from the subsystem's
      title.</p></div></div></div>`;
  }
  const send = m.send;
  const head = `<div class="panel wide" data-reveal>
    <header><h2>Send it to</h2><div class="spacer"></div>
      <button class="btn sm" ${act(copyText,
        "To: " + addrLine(send.to) + "\nCc: " + addrLine(send.cc))}>Copy
        both</button></header>
    <div class="body">
      <p class="hint" style="margin-top:0">${m.path
        ? `For <code>${esc(m.path)}</code>.`
        : `For anything under "${esc(m.query)}".`} Maintainers are
        addressed, reviewers and lists are copied.</p>
      ${people(send.to, "To")}${people(send.cc, "Cc")}
    </div></div>`;

  const sections = m.sections.map((s, i) => `
    <div class="panel wide" data-reveal style="--i:${i + 1}">
      <header><h2>${esc(s.name)}</h2><div class="spacer"></div>
        ${s.status ? `<span class="pill ${
          /Supported|Maintained/i.test(s.status) ? "green"
            : /Orphan|Obsolete/i.test(s.status) ? "red" : "amber"
          }" title="${esc(s.status_means)}">${esc(s.status)}</span>` : ""}
        ${s.catchall ? `<span class="pill grey">catch-all</span>` : ""}
      </header><div class="body">
        <p class="hint" style="margin-top:0">${s.catchall
          ? "The fallback for the whole tree, which is why its list belongs "
            + "on the Cc and its name does not belong on the To."
          : `Matched on <code>${esc(s.why)}</code>.`}${
          s.status_means ? " " + esc(s.status_means) + "." : ""}</p>
        ${people(s.maintainers, "Maintainers")}
        ${people(s.reviewers, "Reviewers")}
        ${s.lists.length ? `<p class="hint">Lists: ${
          s.lists.map((l) => `<span class="mono">${esc(l)}</span>`).join(", ")
        }</p>` : ""}
        ${s.trees.length ? `<p class="hint">Tree: <span class="mono">${
          esc(s.trees[0])}</span></p>` : ""}
        ${s.files.length ? `<p class="hint">Files: ${s.files.map((x) =>
          `<code>${esc(x)}</code>`).join(" ")}</p>` : ""}
      </div></div>`).join("");

  return head + sections;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied.", "ok"),
    () => toast("This browser would not let the page copy that.", "bad"));
}

/* --------------------------------------------------------- your picture */

/* The browser does the shrinking.  A phone camera gives four megabytes and a
   26 pixel circle needs none of it, so the file is drawn into a 256 pixel
   square and what leaves this page is the few tens of kilobytes that
   survive.  Read as a data URL rather than an object URL because this page's
   content policy allows data: images and does not allow blob:. */
const AVATAR_PX = 256;

function shrinkPicture(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("That file could not be read."));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That is not a picture we can read."));
      img.onload = () => {
        /* The middle square of whatever shape they gave us, because a face
           in a circle should not be a squashed face in a circle. */
        const side = Math.min(img.width, img.height);
        if (!side) { reject(new Error("That picture is empty.")); return; }
        const c = document.createElement("canvas");
        c.width = c.height = AVATAR_PX;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2,
                    side, side, 0, 0, AVATAR_PX, AVATAR_PX);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function choosePicture() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change",
      () => resolve((input.files || [])[0] || null));
    input.click();
  });
}

async function changePicture() {
  const file = await choosePicture();
  if (!file) return;
  let url;
  try {
    url = await shrinkPicture(file);
  } catch (e) {
    toast(e.message, "bad");
    return;
  }
  await putPicture(url, "Profile picture set.");
}

async function removePicture() {
  await putPicture("", "Profile picture removed.");
}

async function putPicture(url, said) {
  const r = await post("/api/avatar", { image: url });
  const body = await r.json();
  if (!body.ok) {
    toast(body.error || "That picture was not accepted.", "bad");
    return;
  }
  S.status.account = Object.assign({}, S.status.account || {},
                                   { avatar: body.avatar });
  toast(said, "ok");
  showWho("");
  render();
}

/* Their face if they gave us one, their initial if they did not.  The tag in
   the URL is the picture's own fingerprint, so replacing it asks for a
   different address and no stale one is left showing. */
function avatarFace(acc, label) {
  const tag = (acc || {}).avatar;
  return tag
    ? `<img src="/api/avatar?v=${encodeURIComponent(tag)}" alt="">`
    : esc(((label || "?")[0] || "?").toUpperCase());
}

/* The account, reached from the menu in the corner rather than the sidebar,
   because it is about you rather than about your patches. */
function viewProfile() {
  const st = S.status;
  const p = (S.data && S.data.profile) || {};
  const acc = st.account || {};
  const who = acc.email || p.email || st.who || "";
  const on = st.privacy || [];
  const cloud = st.mode === "cloud";
  const keys = (S.providers || []).filter((x) => x.ready);
  /* The name on the account is the one they gave; the one on the patches is
     whatever they put in their Signed-off-by. They are usually the same. */
  const called = acc.name || p.name || who.split("@")[0] || "Signed in";

  return `<div class="row2" style="align-items:start">
    <div class="panel" data-reveal><header><h2>You</h2></header><div class="body">
      <div class="profilehead">
        <button class="avatar big shot" ${act(changePicture)}
                title="${acc.avatar ? "Choose a different picture"
                                    : "Add a picture"}">
          ${avatarFace(acc, called)}<span class="shotlb">Change</span>
        </button>
        <div>
          <h3>${esc(called)}</h3>
          <p class="hint" style="margin:2px 0 0">${esc(who)}</p>
          <p class="hint" style="margin:6px 0 0">
            <button class="link" ${act(changePicture)}>${
              acc.avatar ? "Replace picture" : "Add a picture"}</button>${
            acc.avatar
              ? ` &middot; <button class="link" ${act(removePicture)}>Remove</button>`
              : ""}
          </p>
        </div>
      </div>
      <dl class="kv">
        ${acc.username ? `<dt>Username</dt><dd>${esc(acc.username)}</dd>` : ""}
        ${acc.since ? `<dt>Account since</dt><dd>${esc(ago(acc.since))}</dd>` : ""}
        <dt>Patches tracked</dt><dd>${S.data ? work().length : 0}</dd>
        <dt>Last collected</dt><dd>${st.generated ? esc(ago(st.generated)) : "not yet"}</dd>
        <dt>Assistant keys</dt>
        <dd>${keys.length ? keys.map((k) => esc(k.label)).join(", ")
                          : "none of your own yet"}</dd>
      </dl>
      ${p.lore ? `<p class="hint">Your posts:
        <a href="${esc(p.lore)}" target="_blank" rel="noopener">on lore</a></p>` : ""}
      <div class="btnrow">
        <button class="btn" ${act(() => go("settings"))}>Settings</button>
        <button class="btn danger" ${act(signOut)}>Sign out</button>
      </div>
    </div></div>

    <div class="panel" data-reveal><header><h2>Your data on this server</h2>
      <div class="spacer"></div>
      <span class="pill ${cloud ? "green" : "grey"}">${esc(st.mode || "local")}</span>
    </header><div class="body">
      <ul class="asklist plain">
        <li>Your patches, notes and API keys live in a directory of your own.
            Nobody else who signs in can reach them.</li>
        <li>Your API keys are encrypted where they sit, and are only ever used
            for your own questions and your own collections.</li>
        <li>${on.includes("reviewer addresses masked")
              ? "Reviewer addresses are masked to <code>a***@domain</code> before they leave this machine."
              : "Reviewer addresses are shown in full, because this is running on your own machine."}</li>
        <li>Nothing is ever written to a kernel mailing list. It only reads.</li>
      </ul>
      <p class="hint">Signing out clears this browser's session. Your collected
      patches stay, and are here when you sign back in.</p>
    </div></div>
  </div>`;
}

/* ------------------------------------------------------------------ tabs */

function tabs(id, items, initial) {
  if (!S.tabs[id]) S.tabs[id] = initial || items[0][0];
  const on = S.tabs[id];
  // Announced as tabs rather than as a row of buttons, which is what they
  // look like and how they behave.  Only the selected one is in the tab
  // order; the arrow keys move between them, per the usual pattern.
  const bar = `<div class="tabs" data-tabs="${esc(id)}" data-reveal
      role="tablist">`
    + items.map(([k, label]) =>
      `<button class="${k === on ? "on" : ""}" role="tab" id="tab-${esc(id)}-${esc(k)}"
        aria-selected="${k === on}" aria-controls="panel-${esc(id)}"
        tabindex="${k === on ? 0 : -1}" ${act(TAB, id, k)}>${
        k === on ? `<i class="tabpill"></i>` : ""}<span>${esc(label)}</span>`
      + `</button>`).join("") + `</div>`;
  const body = (items.find((i) => i[0] === on) || items[0])[2]();
  return bar + `<div role="tabpanel" id="panel-${esc(id)}"
    aria-labelledby="tab-${esc(id)}-${esc(on)}">${body}</div>`;
}

/* The pill under the tabs is flown from where it was to where it is going,
   rather than being drawn again somewhere else. */
function TAB(id, k) {
  S.tabs[id] = k;
  morph(`[data-tabs="${id}"] .tabpill`, () => render());
}

/* -------------------------------------------------------------- the AI */

/* Just enough markdown for what the model actually sends back. */
function md(text) {
  const lines = String(text).split("\n");
  let out = "", list = null;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  /* Wrapped lines are one paragraph, which is how anybody writing prose
     expects them to read.  Taking each line as its own paragraph turns a
     wrapped answer into a column of one-line paragraphs with gaps between
     them, and both the model and the help text here wrap. */
  let para = [];
  const flush = () => {
    if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; }
  };
  const stop = () => { flush(); close(); };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { stop(); continue; }
    let m;
    if ((m = /^#{1,4}\s+(.*)$/.exec(l))) { stop(); out += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = /^[-*]\s+(.*)$/.exec(l))) {
      flush();
      if (list !== "ul") { close(); out += "<ul>"; list = "ul"; }
      out += `<li>${inline(m[1])}</li>`;
    } else if ((m = /^\d+[.)]\s+(.*)$/.exec(l))) {
      flush();
      if (list !== "ol") { close(); out += "<ol>"; list = "ol"; }
      out += `<li>${inline(m[1])}</li>`;
    } else { close(); para.push(l); }
  }
  stop();
  return out;
}

function askAboutRespin(g) {
  askAI(`My series "${g.name}" on ${g.tree} had changes requested on `
    + `${plural(g.patches.length, "patch", "patches")}: `
    + g.patches.map((p) => `"${p.subject}" (${p.state_detail || "no detail"})`)
        .join("; ")
    + `. I sent v${g.sent}. What should change in v${g.sent + 1}, and how `
    + `should I word the cover letter?`);
}

function askAboutThread(t) {
  askAI(`About the thread "${t.series}" on ${t.tree || "the list"}: ${
    t.last_from} wrote "${(t.excerpt || "").slice(0, 200)}". What does that ask `
    + `for, and what should my reply say?`);
}

function aiReady() {
  return (S.providers || []).some((p) => p.ready);
}

function askAI(prompt) {
  openAI();
  /* With no key there is nothing to ask, and the welcome panel already says
     so and offers the way to fix it.  Sending anyway would only produce an
     error the user could have been spared. */
  if (prompt && aiReady()) {
    $("aiinput").value = prompt;
    sendAI();
  } else if (prompt) {
    $("aiinput").value = prompt;
    $("aiinput").focus();
  } else {
    $("aiinput").focus();
  }
}

/* ------------------------------------------------- one patch, in full */

/* Clicking a subject used to throw you at lore in another tab, which knows
   nothing about the versions you sent, where it landed, or whether anybody
   is waiting on you.  All of that is here, so show it here, and keep lore a
   click away for the original. */
function openThread(id, subject) {
  S.thread = { id, subject, loading: true, data: null, error: "" };
  $("thread").classList.add("open");
  $("thscrim").classList.add("on");
  drawThread();
  fetch("/api/thread?id=" + encodeURIComponent(id),
        { headers: { "X-Requested-With": "patchvane" } })
    .then((r) => r.json())
    .then((b) => {
      if (!S.thread || S.thread.id !== id) return;   /* they moved on */
      if (b.ok) S.thread.data = b;
      else S.thread.error = b.error || "could not read that thread";
      S.thread.loading = false;
      drawThread();
    })
    .catch((e) => {
      if (!S.thread || S.thread.id !== id) return;
      S.thread.error = String(e.message || e);
      S.thread.loading = false;
      drawThread();
    });
}

/* A commit, in the same drawer a patch opens in.

   The list it was clicked in is still behind it, which is the whole point:
   somebody scanning a year of somebody else's commits reads five of them,
   and five tabs on git.kernel.org is five page loads and no way back to
   where they were. The link out is still in the header, because cgit has
   the diff and the history and this does not. */
function openCommit(cid, tree) {
  /* act() passes the element and the event along after the arguments given
     to it, so a caller that leaves the tree off sends a DOM node here.
     Mainline is the right guess anyway for a commit named without one. */
  const which = typeof tree === "string" && tree ? tree : "mainline";
  S.thread = { id: cid, kind: "commit", tree: which, loading: true,
               subject: cid.slice(0, 12), data: null, error: "" };
  $("thread").classList.add("open");
  $("thscrim").classList.add("on");
  drawThread();
  fetch("/api/discover/commit?id=" + encodeURIComponent(cid)
        + "&tree=" + encodeURIComponent(which),
        { headers: { "X-Requested-With": "patchvane" } })
    .then((r) => r.json())
    .then((b) => {
      if (!S.thread || S.thread.id !== cid) return;     /* they moved on */
      if (b.ok) S.thread.data = b;
      else S.thread.error = b.error || "could not read that commit";
      S.thread.out = b.url || "";
      S.thread.loading = false;
      drawThread();
    })
    .catch((e) => {
      if (!S.thread || S.thread.id !== cid) return;
      S.thread.error = String(e.message || e);
      S.thread.loading = false;
      drawThread();
    });
}

function drawCommit() {
  const box = $("thbody");
  const st = S.thread;
  const lore = $("thlore");
  lore.textContent = "git.kernel.org \u2197";

  if (st.loading) {
    $("thtitle").textContent = st.subject;
    $("thsub").textContent = "reading the commit\u2026";
    lore.style.display = "none";
    box.innerHTML = `<div class="thwait"><span class="spin"></span>
      Fetching it from git.kernel.org\u2026</div>`;
    return;
  }
  if (st.error) {
    $("thtitle").textContent = st.subject;
    $("thsub").textContent = "";
    /* The way out matters most when the way in did not work. */
    lore.style.display = st.out ? "" : "none";
    lore.href = st.out || "#";
    box.innerHTML = `<div class="empty"><h3>${esc(st.error)}</h3></div>`;
    return;
  }

  const c = st.data;
  $("thtitle").textContent = c.subject || c.short;
  $("thsub").textContent = [c.author, c.date, "in " + c.tree]
    .filter(Boolean).join(" \u00b7 ");
  lore.style.display = "";
  lore.href = c.url;

  box.innerHTML = `<section class="thsec"><dl class="kv">
      <dt>Commit</dt><dd class="mono">${esc(c.commit)}</dd>
      <dt>Author</dt><dd>${esc(c.author || "\u2014")}</dd>
      ${c.committer && c.committer !== c.author
        ? `<dt>Committed by</dt><dd>${esc(c.committer)}</dd>` : ""}
      <dt>Date</dt><dd>${esc(c.date || "\u2014")}</dd>
    </dl></section>
    ${messageView(c.body)}
    ${c.files.length && diffFiles(c.diff).length < 2 ? fold(
      `${plural(c.files.length, "file")} changed`,
      plural(c.files.reduce((n, f) => n + (f.changed || 0), 0), "line"),
      `<ul class="filelist">${c.files.map((f) => `<li>
        <span class="mono">${esc(f.path)}</span>
        <span class="muted">${plural(f.changed, "line")}</span></li>`).join("")}
      </ul>`) : ""}
    ${diffView(c.diff)}`;
}

/* A section the reader opens only if they want it.

   <details> rather than a button and a class of our own: it keeps its own
   open state across redraws, it is reachable from the keyboard without any
   wiring, and find-in-page can open it, which a div never does. */
function fold(title, note, body, open) {
  return `<details class="fold"${open ? " open" : ""}>
    <summary><span class="fmark" aria-hidden="true"></span>
      <span class="ftitle">${esc(title)}</span>
      ${note ? `<span class="fnote">${esc(note)}</span>` : ""}</summary>
    <div class="fbody">${body}</div></details>`;
}

/* The commit message, which is the one part of a commit worth reading before
   deciding whether to read the rest.

   Most of them are a subject and a short paragraph and are better shown than
   folded.  The long ones are long because of a changelog or a revert trail
   under the first paragraph, so the opening stays out and the tail folds. */
const MSG_LINES = 12;

function messageView(body) {
  const text = (body || "").replace(/\s+$/, "");
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= MSG_LINES) {
    return `<section class="thsec"><h3>Message</h3>
      <pre>${esc(text)}</pre></section>`;
  }
  const head = lines.slice(0, MSG_LINES).join("\n");
  const tail = lines.slice(MSG_LINES).join("\n");
  return `<section class="thsec"><h3>Message</h3>
    <pre>${esc(head)}</pre>
    ${fold("Rest of the message",
           plural(lines.length - MSG_LINES, "line"),
           `<pre>${esc(tail)}</pre>`)}</section>`;
}

/* The change itself.

   A commit page that lists which files moved and how many lines, and then
   stops, answers the least interesting question about a commit. The diff is
   the commit. It is rendered a line at a time rather than dropped into one
   block because a diff is unreadable without the colour: the eye finds the
   + and the - long before it reads either.

   It is also the longest thing in the drawer by a wide margin, and a
   treewide typo fix touches sixty files, so it arrives folded: one fold per
   file, named and counted, and the reader opens the one they came for. */
function diffView(d) {
  if (!d) return "";
  if (!d.text) {
    return d.why ? `<section class="thsec"><h3>The change</h3>
      <p class="hint" style="margin:0">${esc(d.why)}.</p></section>` : "";
  }
  const cut = d.cut ? `<p class="hint">This is a long one, so the rest is cut.
    The whole of it is on git.kernel.org.</p>` : "";
  const files = diffFiles(d);
  if (files.length < 2) {
    return `<section class="thsec"><h3>The change</h3>
      ${fold("Show the diff", countChanged(d.text),
             `<div class="diff">${diffRows(d.text)}</div>`)}
      ${cut}</section>`;
  }
  return `<section class="thsec"><h3>The change</h3>
    <p class="hint">${plural(files.length, "file")}. Open one to read it.</p>
    ${files.map((f) => fold(f.path, countChanged(f.text),
        `<div class="diff">${diffRows(stripFileHeader(f.text))}</div>`)).join("")}
    ${cut}</section>`;
}

/* One entry per file the diff touches.  Anything before the first "diff
   --git" is a preamble git puts there and belongs to no file. */
function diffFiles(d) {
  if (!d || !d.text) return [];
  const out = [];
  let cur = null;
  d.text.split("\n").forEach((ln) => {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(ln);
    if (m) {
      cur = { path: m[2] || m[1], lines: [] };
      out.push(cur);
    }
    if (cur) cur.lines.push(ln);
  });
  return out.map((f) => ({ path: f.path, text: f.lines.join("\n") }));
}

/* The "diff --git", "index" and "---/+++" lines name the file, which the
   fold above them has already done.  Repeating it costs four lines of the
   six a one-word typo fix has. */
function stripFileHeader(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("@@")) i++;
  return i < lines.length ? lines.slice(i).join("\n") : text;
}

function countChanged(text) {
  let add = 0, del = 0;
  text.split("\n").forEach((ln) => {
    if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
    else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
  });
  return `+${add} \u2212${del}`;
}

function diffRows(text) {
  const KIND = {
    "+": "add", "-": "del", "@": "hunk", "d": "fh", "i": "fh",
  };
  return text.split("\n").map((ln) => {
    let k = KIND[ln.charAt(0)] || "";
    /* "---" and "+++" name the file; they are not a removed and an added
       line, and colouring them as such makes every file look rewritten. */
    if (ln.startsWith("---") || ln.startsWith("+++")) k = "fh";
    else if (ln.startsWith("diff --git ") || ln.startsWith("index ")
             || ln.startsWith("new file") || ln.startsWith("deleted file")
             || ln.startsWith("similarity ") || ln.startsWith("rename ")) k = "fh";
    else if (k === "d" || k === "i") k = "";
    return `<span class="dl ${k}">${esc(ln) || "&nbsp;"}</span>`;
  }).join("");
}

function closeThread() {
  const d = $("thread");
  const inside = d.contains(document.activeElement);
  d.classList.remove("open");
  $("thscrim").classList.remove("on");
  S.thread = null;
  if (inside) document.body.focus();
}

/* A subject that opens the patch here rather than leaving the page. */
function subj(id, text, cls) {
  return `<a class="${cls || ""}" href="#" ${act(openThread, id, text)}
    >${mark(text)}</a>`;
}

/* The subject of a commit, which opens the commit. Reading a commit subject
   and landing in the mail thread that proposed it is the wrong door: the
   thread is a link of its own wherever both are offered. Falls back to the
   thread for a row that has no commit to open yet. */
function csubj(row, text, cls) {
  const id = row.commit || row.short;
  if (!id) return subj(row.msgid || row.series, text, cls);
  return `<a class="${cls || ""}" href="#"
    ${act(openCommit, id, treeHolding(row))}>${mark(text)}</a>`;
}

/* Of the trees a patch landed in, the one worth linking to.  linux-next is
   rebuilt daily and drops a commit of its own once mainline has it, so a
   patch that made it all the way reads best from Linus' tree. */
function landedIn(rows) {
  return rows.find((l) => l.tree === "mainline") || rows[0];
}

/* Which tree to read a commit out of, for the same reason. */
function treeHolding(row) {
  const t = row.trees || [];
  if (row.mainline || t.indexOf("mainline") >= 0) return "mainline";
  if (row.tree) return row.tree;
  if (row.in_next || t.indexOf("linux-next") >= 0) return "linux-next";
  return t[0] || (row.maintainer_trees || [])[0] || "mainline";
}

/* A commit id that opens here, for the same reason a subject does.  Reading
   five commits off a list should cost five clicks, not five tabs on
   git.kernel.org and no way back to the place in the list. cgit is still
   one click away in the drawer header for the diff itself. */
function sha(row, cls) {
  const id = row.commit || row.short;
  if (!id) return "";
  const short = row.short || id.slice(0, 12);
  return `<a class="mono ${cls || ""}" href="#"
    ${act(openCommit, id, treeHolding(row))}>${mark(short)}</a>`;
}

function drawThread() {
  const box = $("thbody");
  const st = S.thread;
  if (!st) return;
  if (st.kind === "commit") { drawCommit(); return; }
  $("thtitle").textContent = st.subject || "Patch";
  const lore = $("thlore");
  lore.textContent = "Open in lore";

  if (st.loading) {
    $("thsub").textContent = "reading the thread\u2026";
    lore.style.display = "none";
    box.innerHTML = `<div class="thwait"><span class="spin"></span>
      Fetching the conversation from lore\u2026</div>`;
    return;
  }
  if (st.error) {
    $("thsub").textContent = "";
    lore.style.display = "none";
    box.innerHTML = `<div class="thwait">${esc(st.error)}</div>`;
    return;
  }

  const b = st.data, p = b.patch || {}, msgs = b.thread || [];
  lore.style.display = "";
  lore.href = p.lore || "#";
  $("thtitle").textContent = p.subject || st.subject || "Patch";
  $("thsub").textContent = [p.tree_hint || p.list, state(p.state).label]
    .filter(Boolean).join(" \u00b7 ");

  box.innerHTML = whatsNeeded(p, msgs) + whereItLanded(p)
    + versionHistory(p) + inThisSeries(b.series, p)
    + conversation(msgs, b.why);
}

/* The question anybody opening a patch is actually asking. */
function whatsNeeded(p, msgs) {
  const landed = (p.landed || []).length > 0;
  const last = [...msgs].reverse().find((m) => !m.mine && !m.bot);
  const tookIt = msgs.find((m) => m.applied && !m.mine);
  const ACCEPTED = ["accepted", "in-tree", "in-next", "merged", "queued",
                    "awaiting-upstream"];
  let head, note, cls;

  if (p.in_mainline) {
    head = "In mainline. Nothing to do.";
    note = "It is in Linus' tree. The thread is finished with you.";
    cls = "green";
  } else if (landed || p.in_next || ACCEPTED.includes(p.state) || tookIt) {
    /* Whoever said it, however they phrased it, and whatever they called
       the branch. Replying "thanks for applying" is noise on a kernel
       list, so the answer here is to do nothing. */
    const who = tookIt ? tookIt.who : (last ? last.who : "");
    head = p.in_next ? "Applied, and in linux-next. Nothing to do."
                     : "Applied. Nothing to do.";
    note = `${who ? esc(who) + " took this" : "A maintainer took this"}.
      Kernel lists treat a thank-you reply as noise, so no answer is
      expected. Watch for it in linux-next and then in mainline.`;
    cls = "green";
  } else if (p.state === "changes-requested") {
    head = "A new version is owed.";
    note = "Somebody asked for changes. Address them and send the next version.";
    cls = "amber";
  } else if (p.state === "superseded") {
    head = "Replaced by a later version.";
    note = "A newer version of this patch took over. Nothing to do here.";
    cls = "grey";
  } else if (p.state === "rejected") {
    head = "Turned down.";
    note = "A maintainer said no. Read the reason below before resending.";
    cls = "red";
  } else if (last && last.tags.length && !last.question) {
    head = "Reviewed, waiting on a maintainer.";
    note = `${esc(last.who)} gave ${last.tags.map(esc).join(", ")} and asked
      nothing. Nothing is owed from you; it needs a maintainer to pick it up.`;
    cls = "blue";
  } else if (last) {
    head = "Somebody is waiting on you.";
    note = `${esc(last.who)} wrote last${last.question ? " and asked a question"
      : ""}. Their message is below.`;
    cls = "amber";
  } else {
    head = "Posted, nothing back yet.";
    note = "No reply has come in. Give it a week or two before a ping.";
    cls = "grey";
  }
  return `<div class="thneed ${cls}"><h3>${head}</h3><p>${note}</p></div>`;
}

function whereItLanded(p) {
  const rows = p.landed || [];
  if (!rows.length) return "";
  return `<section class="thsec"><h3>The commit</h3>
    <table class="thtable"><tbody>${rows.map((l) => `<tr>
      <td class="thtree">${esc(l.tree)}</td>
      <td>${sha(l)}</td>
      <td class="thdim">${l.author ? esc(l.author) : ""}</td>
      <td class="thdim">${l.date ? esc(l.date.slice(0, 10)) : ""}</td>
    </tr>`).join("")}</tbody></table></section>`;
}

function versionHistory(p) {
  const vs = p.versions || [];
  if (vs.length < 2) return "";
  return `<section class="thsec"><h3>Versions you sent</h3>
    <ol class="thvers">${vs.map((v) => `<li class="${
      v.version === p.version ? "on" : ""}">
      <b>v${esc(String(v.version))}</b>
      <span class="thdim">${esc((v.date || "").slice(0, 10))}</span>
      ${v.version === p.version ? '<span class="pill grey">this one</span>' : ""}
      ${v.lore ? `<a href="${esc(v.lore)}" target="_blank"
        rel="noreferrer">lore</a>` : ""}
    </li>`).join("")}</ol></section>`;
}

function inThisSeries(rows, p) {
  if (!rows || rows.length < 2) return "";
  return `<section class="thsec"><h3>The rest of the series</h3>
    <ul class="thseries">${rows.map((r) => `<li class="${
      r.msgid === p.msgid ? "on" : ""}">
      ${pill(r.state)}
      ${esc(r.subject || "")}
    </li>`).join("")}</ul></section>`;
}

function conversation(msgs, why) {
  if (!msgs.length) {
    return `<section class="thsec"><h3>The conversation</h3>
      <p class="hint">${esc(why || "Nothing came back on this one yet.")}</p>
      </section>`;
  }
  /* The newest message is the one that was come for: it is what somebody
     said last and what any answer has to answer. The rest is history, and a
     thread that ran to nine rounds buries it under eight of them. So the
     last one is open and the others are shut, each still showing who wrote
     it and when, which is all that is needed to decide to open one. */
  const last = msgs.length - 1;
  return `<section class="thsec"><h3>The conversation
    <span class="thdim">${msgs.length} message${msgs.length > 1 ? "s" : ""}</span>
    ${msgs.length > 1 ? `<span class="spacer"></span>
      <button class="link sm" ${act(openEveryMessage)}>expand all</button>` : ""}
    </h3>
    ${why ? `<p class="hint">${esc(why)}</p>` : ""}
    <div class="thmsgs">${msgs.map((m, i) => `<details class="thmsg${
      m.mine ? " mine" : ""}${m.bot ? " bot" : ""}"${i === last ? " open" : ""}>
      <summary>
        <span class="fmark" aria-hidden="true"></span>
        <b>${esc(m.who || "somebody")}</b>
        ${m.mine ? '<span class="pill grey">you</span>' : ""}
        ${m.bot ? '<span class="pill grey">bot</span>' : ""}
        ${m.applied ? '<span class="pill green">applied it</span>' : ""}
        ${(m.tags || []).map((t) => `<span class="pill blue">${esc(t)}</span>`).join("")}
        <span class="spacer"></span>
        <span class="thdim">${esc(ago(m.date))}</span>
      </summary>
      <div class="msgbody">
        <pre>${esc(trimQuotes(m.body || ""))}</pre>
        ${m.lore ? `<p class="thlink"><a href="${esc(m.lore)}" target="_blank"
          rel="noreferrer">this message on lore \u2197</a></p>` : ""}
      </div>
    </details>`).join("")}</div></section>`;
}

function openEveryMessage(el) {
  const box = el.closest(".thsec");
  const all = [...box.querySelectorAll("details.thmsg")];
  const shut = all.some((d) => !d.open);
  all.forEach((d) => { d.open = shut; });
  el.textContent = shut ? "collapse all" : "expand all";
}

/* A reply that quotes the whole patch back is mostly the patch.  Keep the
   short quotes, which are the thing being answered, and fold the rest. */
function trimQuotes(body) {
  const out = [];
  let run = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith(">")) {
      run++;
      if (run <= 6) out.push(line);
      else if (run === 7) out.push("\u2026");
      continue;
    }
    run = 0;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function openAI() {
  $("ai").classList.add("open");
  $("aiscrim").classList.add("on");
  drawChat();
  /* Fetched when the drawer opens rather than when the panel does, so the
     count under the clock is right the first time it is looked at. */
  loadChats().then(() => { if (S.histOpen) drawHistory(); });
}

function closeAI() {
  const drawer = $("ai");
  /* Focus has to come back out with the drawer.  Left behind in the textarea
     it swallows every keyboard shortcut, since they all stand down while you
     are typing, and the page goes quietly dead. */
  const inside = drawer.contains(document.activeElement);
  drawer.classList.remove("open");
  $("aiscrim").classList.remove("on");
  if (inside) $("aibtn").focus();
}

function openAISettings() {
  closeAI();
  go("settings");
  TAB("set", "ai");
}

/* The picker sits with the input rather than in the header, because it is
   part of asking rather than part of the drawer. */
function modelPicker() {
  const ready = (S.providers || []).filter((p) => p.ready);
  if (!ready.length) return "";
  const on = S.model || "";
  const current = on ? ready.find((p) => p.id === on) : null;
  return `<div class="picker">
    <button class="pk ${S.pickOpen ? "on" : ""}" ${act(togglePicker)}
      title="Which model answers">
      <span class="sparkle">\u2726</span>${
        current ? esc(current.label) : "Auto"}<i>\u25BE</i></button>
    ${S.pickOpen ? `<div class="pkmenu">
      <button class="${on ? "" : "on"}" ${act(pickModel, "")}>
        <strong>Auto</strong><i>best fit for the question, with fallback</i></button>
      ${ready.map((p) => `<button class="${on === p.id ? "on" : ""}"
        ${act(pickModel, p.id)}>
        <strong>${esc(p.label)}</strong><i>${esc(p.model)}</i></button>`).join("")}
      <button class="more" ${act(openAISettings)}>Add another model\u2026</button>
    </div>` : ""}
  </div>`;
}

function togglePicker() { S.pickOpen = !S.pickOpen; drawChat(); }

function pickModel(id) {
  S.model = id;
  S.pickOpen = false;
  drawChat();
  $("aiinput").focus();
}

/* A provider asked twice should be named once, and saying "tried Gemini"
   when Gemini is the only one configured tells you nothing you want to hear
   twice over. */
function tried(trail) {
  const names = [...new Set((trail || []).map((t) => t.label))];
  if (names.length < 2) return "";
  return `<div class="via">tried ${names.map(esc).join(", ")}</div>`;
}

function via(m) {
  if (!m.provider) return "";
  const fell = (m.fellback || []).filter((t) => t.detail);
  return `<div class="via">
    answered by <strong>${esc(m.label || m.provider)}</strong>
    <span class="mono">${esc(m.model || "")}</span>
    ${fell.length ? `<span class="fell" title="${esc(
        fell.map((t) => `${t.label}: ${t.detail}`).join("\n"))}">
        after ${fell.map((t) => esc(t.label)).join(", ")} could not</span>` : ""}
  </div>`;
}

function drawChat() {
  const box = $("aichat");
  if (!box) return;
  const form = $("aipicker");
  if (form) form.innerHTML = modelPicker();

  if (!S.chat.length) {
    const ready = (S.providers || []).filter((p) => p.ready);
    box.innerHTML = `<div class="aiwelcome">
      <div class="aimark">\u2726</div>
      <h3>Ask about your own patches</h3>
      <p>${ready.length
        ? `I can see everything this dashboard collected: totals, per tree
           numbers, landed commits, open threads and review tags. ${
           ready.length > 1
             ? `${plural(ready.length, "model")} are set up, and the one that
                suits the question gets it.`
             : `Using ${esc(ready[0].label)}.`}`
        : "No model has an API key yet. Add one and come back."}</p>
      <div class="aisug">${ready.length
        ? SUGGESTIONS.map((s) => `<button ${act(askAI, s)}>${esc(s)}</button>`).join("")
        : `<button class="btn primary" ${act(openAISettings)}>Open settings</button>`}
      </div></div>`;
    box.scrollTop = 0;
    return;
  }

  box.innerHTML = S.chat.map((m) => m.role === "user"
    ? `<div class="msg me">${esc(m.text)}</div>`
    : m.error
      ? `<div class="msg bot err">${esc(m.text)}${m.key
          ? ` <button class="link" ${act(openAISettings)}>Add a key</button>` : ""}${
        m.retry ? ` <button class="link" ${act(retryAsk, m.retry)}>Ask again</button>` : ""}
         ${tried(m.trail)}</div>`
      : `<div class="msg bot">${md(m.text)}
         <div class="msgfoot">${via(m)}<span class="spacer"></span>
           <button class="link" ${act(copyText, m.text)}>copy</button>
         </div></div>`).join("")
    + (S.asking ? `<div class="msg bot thinking"><i></i><i></i><i></i></div>` : "");
  box.scrollTop = box.scrollHeight;
}

async function sendAI() {
  const input = $("aiinput");
  const q = input.value.trim();
  if (!q || S.asking) return;
  input.value = "";
  input.style.height = "auto";
  S.chat.push({ role: "user", text: q });
  S.asking = true;
  drawChat();
  try {
    /* The conversation so far goes with the question, so a follow-up like
       "what about the other one" reaches the model with the thing it refers
       to still in view.  Errors and the turn just pushed are left out. */
    const past = S.chat
      .slice(0, -1)
      .filter((m) => !m.error && m.text)
      .slice(-12)
      .map((m) => ({ role: m.role === "bot" ? "assistant" : "user",
                     text: m.text }));
    const r = await post("/api/ai",
                         { prompt: q, provider: S.model || "", history: past });
    if (r.status === 401) { location.href = "/login"; return; }
    const body = await r.json();
    S.chat.push(body.ok
      ? { role: "bot", text: body.text, provider: body.provider,
          model: body.model, label: body.label, fellback: body.fellback,
          trail: body.trail }
      : { role: "bot", error: true, key: !!body.needs_key, trail: body.trail,
          text: body.error || "The assistant failed." });
  } catch (e) {
    /* "Failed to fetch" is all the browser says when the connection drops,
       usually because the dashboard was restarted mid-question.  Say what
       that means, and offer the question back rather than losing it. */
    S.chat.push({ role: "bot", error: true, retry: q,
      text: "Could not reach the dashboard. It may have restarted while the "
          + "question was in flight." });
  } finally {
    S.asking = false;
    drawChat();
    rememberChat();
  }
}

/* Put a question that never got through back in the box. */
function retryAsk(text) {
  const input = $("aiinput");
  input.value = text;
  S.chat = S.chat.filter((m) => m.retry !== text);
  drawChat();
  sendAI();
}

async function loadProviders() {
  try {
    const r = await fetch("/api/ai/providers", { cache: "no-store" });
    if (!r.ok) return;
    const body = await r.json();
    S.providers = body.providers || [];
    S.zones = body.zones || {};
    S.status.can_store_key = body.can_store_key;
  } catch (e) { /* the settings page will just show nothing configured */ }
}

function label(id) {
  const p = (S.providers || []).find((x) => x.id === id);
  return p ? p.label : id;
}

async function saveKey(id) {
  const box = document.querySelector(`[data-key="${id}"]`);
  const key = box ? box.value.trim() : "";
  if (!key) { toast("Paste a key first.", "bad"); return; }
  const rem = document.querySelector(`[data-remember="${id}"]`);
  const r = await post("/api/ai/key",
    { provider: id, key, remember: rem ? rem.checked : false });
  const body = await r.json();
  S.providers = body.providers || S.providers;
  S.status.ai = (body.ready || []).length > 0;
  S.status.ai_ready = body.ready || [];
  S.keyOpen = "";
  /* The server asked the key what it runs and picked out of that, so the
     list is already known here and opening the dropdown costs nothing. */
  if (body.models && body.models.length) {
    S.modelList = S.modelList || {};
    S.modelList[id] = { models: body.models, best: body.model,
                        spares: (S.modelList[id] || {}).spares || [] };
  }
  toast(body.stored ? `${label(id)} key saved and remembered.`
                    : `${label(id)} key set for this session.`, "ok");
  if (body.model) {
    toast(body.guessed
      ? `${label(id)} would not list its models, so this is set to `
        + `${body.model} as a guess. Change it if it is wrong.`
      : `Set to ${body.model}, the strongest of the ${body.models.length} `
        + `your key reaches.`, body.guessed ? "" : "ok");
  }
  render();
  testKey(id);          // say straight away whether it actually works
}

async function clearKey(id) {
  const r = await post("/api/ai/key", { provider: id, key: "", remember: true });
  const body = await r.json();
  S.providers = body.providers || S.providers;
  S.status.ai = (body.ready || []).length > 0;
  S.status.ai_ready = body.ready || [];
  S.keyTest = null;
  if (S.model === id) S.model = "";
  toast(`${label(id)} key removed.`);
  render();
}

async function testKey(id) {
  S.keyTest = { id, pending: true, msg: "asking " + label(id) + "\u2026" };
  render();
  try {
    const r = await post("/api/ai/test", { provider: id });
    const body = await r.json();
    if (body.ok && body.switched_from) {
      /* The model that was set is gone, and one that works has been put in
         its place.  Say so plainly rather than silently answering on a
         different model than the one on screen. */
      S.keyTest = { id, ok: true, moved: true,
        msg: `${esc(body.switched_from)} is not available on your key any `
           + `more, so this is now set to ${esc(body.model)}, which answered.` };
      await loadProviders();   // the card must show the model it moved to
    } else {
      S.keyTest = body.ok
        ? { id, ok: true, msg: `${label(id)} answered on ${body.model}.` }
        : { id, ok: false, msg: body.error || "No answer." };
    }
  } catch (e) {
    S.keyTest = { id, ok: false, msg: String(e.message || e) };
  }
  render();
}

/* ------------------------------------------------------------------ shell */

function until(iso) {
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  if (secs < 60) return "less than a minute";
  const mins = Math.round(secs / 60);
  return mins < 90 ? plural(mins, "minute") : plural(Math.round(mins / 60), "hour");
}

function navCounts() {
  /* Reports are counted whether or not any patches have been collected:
     the inbox is about the deployment, not about the collection, and on a
     server where the first collection is still running it is the only
     section with anything in it. */
  /* Once the reports themselves are on the page they are what the count is
     read from, so answering one puts the badge down straight away rather
     than at the next reload. */
  const waiting = S.inboxAsked
    ? (S.inbox || []).filter((r) => r.status === "new").length
    : ((S.support || {}).waiting || 0);
  const own = waiting ? { inbox: waiting } : {};
  const d = S.data;
  if (!d) return own;
  const owed = owedWork();
  return Object.assign(own, {
    owed: owed.replies.threads.length + owed.respin.series.length,
    patches: work().length,
    outcomes: d.merged.length + owed.dropped.length,
    discussions: conversations().length,
  });
}

function renderNav() {
  const counts = navCounts();
  const nav = $("nav");
  /* The highlight is not part of the list.  It outlives every redraw, so
     that moving from one section to another moves one object instead of
     turning a background off here and on there. */
  if (!nav.querySelector(".navlist")) {
    nav.innerHTML = `<span class="navglow" aria-hidden="true"></span>
      <div class="navlist"></div>`;
  }
  nav.querySelector(".navlist").innerHTML = navList().map(([id, label, icon]) => `
    <button class="navitem ${S.view === id ? "active" : ""} ${
      !S.data && NO_DATA_NEEDED[id] ? "ready" : ""}" ${act(go, id)}>
      <span class="ico">${icon}</span><span class="lb">${esc(label)}</span>
      ${counts[id] !== undefined ? `<span class="count">${counts[id]}</span>` : ""}
    </button>`).join("");
  placeGlow();
}

/* Put the highlight behind whichever section is open.  Settings and Profile
   are not in the sidebar, so there it has nothing to sit under and gets out
   of the way rather than pointing at the wrong thing. */
function placeGlow() {
  const nav = $("nav");
  const glow = nav && nav.querySelector(".navglow");
  if (!glow) return;
  const on = nav.querySelector(".navitem.active");
  if (!on) { glow.classList.remove("on"); return; }
  glow.style.setProperty("--x", on.offsetLeft + "px");
  glow.style.setProperty("--y", on.offsetTop + "px");
  glow.style.setProperty("--w", on.offsetWidth + "px");
  glow.style.setProperty("--h", on.offsetHeight + "px");
  glow.classList.add("on");
}

window.addEventListener("resize", placeGlow);

const VIEWS = {
  overview:    ["Overview", "where everything stands today", viewOverview],
  owed:        ["Your turn", "replies to write and versions to respin", viewOwed],
  patches:     ["Patches", "everything you have posted", viewPatches],
  outcomes:    ["Outcomes", "what landed and what did not", viewOutcomes],
  discussions: ["Discussions", "threads, people and review tags", viewDiscussions],
  insights:    ["Insights", "activity, subsystems and trees", viewInsights],
  discover:    ["Discover", "anybody else's patches, and who to send yours to",
                viewDiscover],
  inbox:       ["Feedback", "what people sent you, and what you said back",
                viewInbox],
  settings:    ["Settings", "refresh, assistant and sources", viewSettings],
  profile:     ["Profile", "your account and what this server keeps", viewProfile],
};

/* Older links and bookmarks should not land on an error. */
const MOVED = { landed: "outcomes", watchlist: "owed" };

function go(view) {
  view = MOVED[view] || view;
  if (!VIEWS[view]) view = "overview";
  if (S.view === view) { render(); return; }
  S.view = view;
  location.hash = view;
  /* The top of the new section is taken while the page is mid-flow, rather
     than scrolled to afterwards.  A smooth scroll racing the transition is
     two movements at once, and the eye reads that as a stutter. */
  transition(() => {
    render();
    const content = document.querySelector(".content");
    if (content) content.scrollTop = 0;
    if (window.scrollY) window.scrollTo(0, 0);
  });
}

function signOut() { snapDrop(); location.href = "/logout"; }

/* Start again, with nothing carried over: the whole conversation goes to the
   model with every question, so an old thread is not just clutter on screen,
   it is context the next answer will be built on.

   Nothing is lost by this.  What was on screen was written down as it
   happened and is one click away under the clock. */
function newChat() {
  S.chat = [];
  S.chatId = "";
  S.histOpen = false;
  S.chatWho = (S.status && S.status.who) || "";
  drawChat();
  const input = $("aiinput");
  if (input) { input.value = ""; input.style.height = "auto"; input.focus(); }
}

/* ------------------------------------------------- conversations kept

   A question worth asking once is worth finding again: what somebody asked
   the assistant about a series three weeks ago is often exactly what they
   want when the next version comes back.  So a conversation is written down
   as it happens, on the server rather than in this browser, because the
   dashboard is reachable from more than one machine and a history that only
   exists on the laptop is a history that is missing whenever it matters. */

async function loadChats() {
  try {
    const r = await fetch("/api/ai/chats", { cache: "no-store" });
    if (!r.ok) return;
    const body = await r.json();
    S.chats = body.chats || [];
  } catch (e) { /* the drawer works without the list */ }
}

/* Written down after each answer rather than on the way out: a browser that
   is closed mid-conversation, or a laptop that sleeps and never comes back,
   would otherwise take the whole thing with it. */
async function rememberChat() {
  const turns = S.chat.filter((m) => !m.error && m.text)
    .map((m) => ({ role: m.role, text: m.text, provider: m.provider || "",
                   model: m.model || "", label: m.label || "" }));
  if (!turns.length) return;
  try {
    const r = await post("/api/ai/chat", { id: S.chatId, turns });
    const body = await r.json();
    if (!body.ok) return;
    S.chatId = body.id;
    S.chats = body.chats || S.chats;
    if (S.histOpen) drawHistory();
  } catch (e) { /* it stays on screen either way */ }
}

function toggleHistory() {
  S.histOpen = !S.histOpen;
  $("aipast").setAttribute("aria-expanded", S.histOpen ? "true" : "false");
  if (S.histOpen) loadChats().then(drawHistory);
  drawHistory();
}

function drawHistory() {
  const box = $("aihist");
  if (!box) return;
  box.classList.toggle("hidden", !S.histOpen);
  if (!S.histOpen) return;

  if (!S.chats.length) {
    box.innerHTML = `<div class="histempty">
      <p>Nothing asked yet. Conversations turn up here as you have them, and
      stay until you remove them.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="histhead">
      <strong>${plural(S.chats.length, "conversation")}</strong>
      <span class="spacer"></span>
      <button class="link" ${act(forgetChats)}>Remove all</button>
    </div>
    <div class="histlist">${S.chats.map((c) => `
      <div class="hitem ${c.id === S.chatId ? "on" : ""}">
        <button class="hopen" ${act(openChat, c.id)}>
          <strong>${esc(c.title)}</strong>
          <i>${esc(ago(c.updated))} \u00b7 ${plural(c.turns, "turn")}</i>
        </button>
        <button class="hdrop iconbtn" ${act(forgetChat, c.id)}
          title="Remove this conversation">\u00d7</button>
      </div>`).join("")}</div>`;
}

async function openChat(id) {
  try {
    const r = await fetch("/api/ai/chat?id=" + encodeURIComponent(id),
                          { cache: "no-store" });
    const body = await r.json();
    if (!body.ok) { toast(body.error || "Could not open that.", "bad"); return; }
    S.chat = (body.chat.turns || []).map(
      (t) => ({ role: t.role, text: t.text, provider: t.provider,
                model: t.model, label: t.label }));
    S.chatId = body.chat.id;
    S.histOpen = false;
    $("aipast").setAttribute("aria-expanded", "false");
    drawHistory();
    drawChat();
    const input = $("aiinput");
    if (input) input.focus();
  } catch (e) {
    toast("Could not reach the dashboard.", "bad");
  }
}

async function forgetChat(id) {
  try {
    const r = await post("/api/ai/chat/forget", { id });
    const body = await r.json();
    S.chats = body.chats || [];
    /* Removing the one being read leaves the words on screen but nothing
       behind them, so it becomes a new conversation rather than quietly
       writing itself back on the next answer. */
    if (id === S.chatId) S.chatId = "";
    drawHistory();
  } catch (e) {
    toast("Could not reach the dashboard.", "bad");
  }
}

async function forgetChats() {
  if (!confirm("Remove every saved conversation? This cannot be undone."))
    return;
  try {
    const r = await post("/api/ai/chat/forget", { all: true });
    const body = await r.json();
    S.chats = body.chats || [];
    S.chatId = "";
    drawHistory();
    toast("History cleared.");
  } catch (e) {
    toast("Could not reach the dashboard.", "bad");
  }
}

/* Signing in as somebody else must not inherit their conversation. */
function chatBelongsToMe() {
  const who = (S.status && S.status.who) || "";
  if (S.chatWho && S.chatWho !== who) {
    S.chat = [];
    S.chatId = "";
    S.chats = [];
    S.histOpen = false;
    S.asking = false;
    /* Somebody else is signed in now; the page kept for the last one goes
       with their conversation. */
    snapDrop();
  }
  S.chatWho = who;
}

function toggleWhoMenu(want) {
  const menu = $("whomenu");
  const open = want === undefined ? menu.classList.contains("hidden") : want;
  menu.classList.toggle("hidden", !open);
  $("whobtn").setAttribute("aria-expanded", open ? "true" : "false");
}

/* The one view that is not about the person looking at it, and so is the
   one view that works before their first collection has finished -- or when
   it has failed, which is when being able to reach something is worth the
   most. */
/* Sections that are about something other than the collection, and so have
   something to show before the first one has finished. */
const NO_DATA_NEEDED = { discover: true, inbox: true };

/* keepFocus: the id of a grid whose search box should keep the caret. */
function render(keepFocus) {
  if (!S.data && !NO_DATA_NEEDED[S.view]) return;
  const [title, sub, fn] = VIEWS[S.view] || VIEWS.overview;
  $("viewtitle").textContent = title;
  $("viewsub").textContent = sub;

  /* Typing in a search box re-renders on every keystroke, so remember where
     the caret was before the markup underneath it is thrown away. */
  let caret = null;
  if (keepFocus) {
    const old = document.querySelector(`[data-search="${keepFocus}"]`);
    if (old) caret = old.selectionStart;
  }

  /* Every closure in here belongs to the markup about to be replaced. */
  CMD.clear();
  CHARTS.clear();

  /* Pressing a button inside a view rebuilds that view, and replaying the
     entrance animation and jumping to the top every time makes a toggle look
     like the page reloaded.  Animate on arrival; after that, redraw in
     place. */
  const arriving = S.painted !== S.view;
  /* Which element actually scrolls depends on the window: below a certain
     height the whole document does, above it the content column does.  Put
     both back. */
  const scroller = document.querySelector(".content");
  const wasAt = !arriving && scroller ? scroller.scrollTop : 0;
  const wasWin = arriving ? 0 : window.scrollY;

  const el = $("view");
  el.innerHTML = fn();
  mountCharts();
  runCounters();
  if (arriving) reveal(el);
  else el.querySelectorAll("[data-reveal]").forEach((n) => n.classList.add("seen"));
  renderNav();
  drawStamp();
  S.painted = S.view;
  if (scroller && wasAt) scroller.scrollTop = wasAt;
  if (wasWin) window.scrollTo(0, wasWin);

  /* The drawer lives outside the view but its buttons were registered in the
     same map, so it has to be redrawn alongside. */
  if ($("ai").classList.contains("open")) drawChat();

  if (keepFocus) {
    const box = document.querySelector(`[data-search="${keepFocus}"]`);
    if (box) {
      const at = caret === null ? box.value.length : caret;
      box.focus();
      box.setSelectionRange(at, at);
    }
  }
}

function drawStamp() {
  if (!S.data) return;
  const st = S.status;
  $("stamp").textContent = "updated " + ago(S.data.generated);
  $("live").className = "dot " + (S.busy || st.running ? "working"
    : S.offline || st.auto === false ? "paused" : st.last_error ? "bad" : "live");
  /* Some of what is on screen may be older than the rest, because a host
     could not be reached and the last known answer was used instead.  That
     is better than reporting nothing, but only if it is said out loud. */
  const old = S.data.stale;
  const busy = S.busy || st.running;
  $("stampsub").textContent = S.offline ? "saved snapshot"
    : busy ? ""
    : S.stale ? "new data ready"
    : st.last_error ? "last run failed"
    : old ? "some of this is from an earlier run"
    : st.auto === false ? "auto refresh off"
    : st.next_run ? "next in " + until(st.next_run) : "";
  drawMiniProgress(busy && !S.offline ? st.progress : null);
  $("stampsub").title = old
    ? "Could not reach " + old.hosts.join(", ") + " on the last run, so the "
      + "answers from before were kept rather than reporting nothing."
    : "";
  showWho(S.data.profile.email || "");
}

/* How far the running collection has got, in the corner where the words
   "collecting now" used to be.  Passed null when nothing is running, which
   takes the bar off the page rather than leaving it at whatever it last
   reached. */
function drawMiniProgress(p) {
  const bar = $("minibar"), fill = $("minifill"), pct = $("minipct");
  if (!bar) return;
  if (!p) {
    bar.hidden = true;
    /* Back to nothing, so the next collection grows from the left rather
       than picking up where the previous one stopped. */
    fill.style.width = "0";
    bar.classList.remove("waiting");
    return;
  }
  bar.hidden = false;
  const n = typeof p.percent === "number" ? Math.max(0, Math.min(100, p.percent)) : null;
  /* The collector counts what it has read, not what it has left, so there
     is a stretch at the start with nothing to divide by. */
  bar.classList.toggle("waiting", n === null);
  if (n === null) {
    pct.textContent = "";
    bar.removeAttribute("aria-valuenow");
  } else {
    fill.style.width = n + "%";
    pct.textContent = n + "%";
    bar.setAttribute("aria-valuenow", n);
  }
  bar.title = p.label
    ? p.label + (p.total ? " \u2014 " + p.done + " of " + p.total : "")
    : "Collecting";
}

/* Whose dashboard this is.  Taken from the session rather than the collected
   file, so it is right even before anything has been collected.

   Their name if the account has one, because "Hemanth" in the corner reads
   as your own page in a way that an email address does not.  The address is
   still what identifies it, and is a hover away. */
function showWho(email) {
  const acc = (S.status && S.status.account) || {};
  const who = email || (S.status && S.status.who) || "";
  const label = acc.first || acc.username || who;
  $("userlabel").textContent = label;
  $("userlabel").parentElement.title = who || "Account";
  $("avatar").innerHTML = avatarFace(acc, label);
}

/* ------------------------------------------------------------------ data */

/* The last page this browser was shown, so a sign-in opens on the dashboard
   instead of on nothing while a megabyte of JSON is on its way.

   localStorage belongs to the browser profile rather than to whoever is
   signed in, and it outlives the session, so a snapshot is kept under the
   address it was collected for and thrown away on the way out and on any
   change of account. Two people sharing a machine must not find each
   other's patches in here. It is only ever a head start: what the server
   says replaces it as soon as it arrives. */
const SNAP = "patchvane:snapshot:";

function snapDrop() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf(SNAP) === 0) localStorage.removeItem(k);
    }
  } catch (e) { /* storage turned off: there is nothing to drop */ }
}

function snapSave(who, data) {
  if (!who || !data) return;
  try {
    localStorage.setItem(SNAP + who, JSON.stringify(data));
  } catch (e) {
    /* Over quota, or storage refused. This is an optimisation and nothing
       depends on it, so clear out rather than leave half a page behind. */
    snapDrop();
  }
}

function snapLoad(who) {
  if (!who) return null;
  try {
    const raw = localStorage.getItem(SNAP + who);
    if (!raw) return null;
    const d = JSON.parse(raw);
    /* Only this person's, and only if it still looks like a dashboard:
       the shape changes between versions and a half-read one would throw
       somewhere deep in a view. */
    return d && d.profile && d.kpis && d.threads ? d : null;
  } catch (e) {
    return null;
  }
}

async function load() {
  const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
  if (r.status === 401) { location.href = "/login"; return false; }
  if (r.status === 404) {
    /* Signed in, but nothing collected for this person yet.  On a first
       sign-in that is normal and already being worked on. */
    const body = await r.json().catch(() => ({}));
    /* The server has nothing for this person, so a snapshot of theirs is
       no longer true. */
    snapDrop();
    firstRun(body.who || "", body.collecting, body.progress);
    return false;
  }
  if (!r.ok) throw new Error("Could not read the collected patches.");
  S.data = await r.json();
  snapSave((S.status && S.status.who) || (S.data.profile || {}).email, S.data);
  return true;
}

/* The first time somebody signs in there is nothing to show yet, because
   reading a few hundred threads off lore takes minutes.  Say that, keep
   checking, and open the dashboard the moment it is there. */
function firstRun(who, collecting, progress) {
  document.body.classList.add("firstrun");
  showWho(who);
  $("bar").classList.add("hidden");
  $("viewtitle").textContent = "Setting up";
  $("viewsub").textContent = who || "";
  $("view").innerHTML = `<div class="panel wide"><div class="body">
    <div class="empty tall">
      <h3>Reading your patches from the archives</h3>
      <p>This is the first time this address has signed in, so everything
      has to be fetched: every message you posted, every thread, and which
      trees they reached.</p>
      <div class="prog waiting" id="prog"><div class="fill" id="progfill"></div></div>
      <p class="progline">
        <span id="progwhat">${collecting === false
          ? "Starting the collection" : "Getting ready"}</span>
        <span class="pct" id="progpct"></span>
      </p>
      <p class="muted" id="firstwait">This page opens by itself when it is
      ready, so there is nothing to do but wait.</p>
      <div class="btnrow" style="justify-content:center">
        <button class="btn" ${act(go, "discover")}>Try Discover meanwhile</button>
      </div>
      <p class="hint">Discover reads the public archives rather than your
      collection, so it works already.</p>
    </div>
  </div></div>`;
  drawProgress(progress);

  /* Poll faster than the collection changes, so the bar moves in step with
     the work rather than in five second jumps. */
  const began = Date.now();
  const tick = setInterval(async () => {
    try {
      const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
      if (r.status === 401) { location.href = "/login"; return; }
      if (r.ok) {
        clearInterval(tick);
        S.data = await r.json();
        snapSave((S.status && S.status.who) || who, S.data);
        document.body.classList.remove("firstrun");
        S.view = location.hash.replace("#", "") || "overview";
        S.painted = "";
        render();
        return;
      }
      const body = await r.json().catch(() => ({}));
      drawProgress(body.progress, Math.round((Date.now() - began) / 1000));
      if (body.failed && !body.collecting) {
        $("progwhat").textContent = "The archives could not be reached";
        $("firstwait").textContent = "Trying again shortly.";
      }
    } catch (e) { /* the server going away for a moment is fine */ }
  }, 1500);
}

/* The collector counts its own work, so the bar is a real share of it and
   never runs ahead of what has been done. */
function drawProgress(p, waited) {
  const bar = $("prog"), fill = $("progfill");
  if (!bar || !fill) return;
  const pct = p && typeof p.percent === "number" ? p.percent : null;
  bar.classList.toggle("waiting", pct === null);
  if (pct !== null) fill.style.width = pct + "%";
  if (p && p.label) {
    const of = p.total ? ` ${p.done} of ${p.total}` : "";
    $("progwhat").textContent = p.label + of + (p.note && p.total
      ? "" : p.note ? " \u2014 " + p.note : "");
  }
  $("progpct").textContent = pct === null ? "" : pct + "%";
  if (waited !== undefined) {
    const mins = Math.floor(waited / 60);
    $("firstwait").textContent = (mins
      ? "waiting " + plural(mins, "minute")
      : "waiting " + waited + " seconds") + " so far";
  }
}

/* A scheduled collection must not rearrange the page under someone's hands.
   Anything typed, any open chooser, and the moment right after a click all
   count as busy; the new numbers wait a few seconds for a gap. */
let LAST_TOUCH = 0;
document.addEventListener("pointerdown", () => { LAST_TOUCH = Date.now(); }, true);

function interacting() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  if (document.querySelector(".menu")) return true;
  if ($("ai").classList.contains("open")) return true;
  return Date.now() - LAST_TOUCH < 2500;
}

/* The theme the server is holding for this person, applied once when the
   first status arrives. Only then: after that this machine's own toggle is
   the newer opinion, and adopting the saved one again would undo it. */
/* The appearance the server is holding, taken once for the same reason the
   theme is: after the first status arrives, this machine's own Settings are
   the newer opinion. The wallpaper it names may be one whose image lives in
   another browser, which applyLook falls back from on its own. */
function adoptLook(saved) {
  if (S.lookSettled || !saved) return;
  S.lookSettled = true;
  const now = look();
  if (["skin", "wall", "clarity"].every((k) => now[k] === saved[k])) return;
  Object.assign(now, saved);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(now)); } catch (e) {}
  applyLook();
  render();
}

function adoptTheme(theme) {
  if (S.themeSettled || !theme) return;
  S.themeSettled = true;
  paintThemeBtn(theme);
  if (document.documentElement.dataset.theme === theme) return;
  tinting();
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("patchvane-theme", theme);
  render();
}

/* Twenty seconds is the right distance apart for "has anything changed",
   and far too far apart for a bar that is supposed to be moving, which
   would step once and look stuck between. So the loop closes up while a
   collection is running and opens out again when it finishes. */
function pollLoop() {
  const soon = () => (S.busy || (S.status && S.status.running)) ? 2000 : 20000;
  const again = () => setTimeout(async () => {
    await pollStatus();
    again();
  }, soon());
  again();
}

async function pollStatus() {
  if (S.offline) return;
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (r.status === 401) { location.href = "/login"; return; }
    const st = await r.json();
    const was = S.status.running;
    S.status = st;
    adoptTheme(st.theme);
    chatBelongsToMe();
    if (S.data && st.generated && st.generated !== S.data.generated) {
      await load();
      S.stale = true;
    }
    if (S.stale && !interacting()) {
      S.stale = false;
      render();
      if (was) toast("Fresh data collected.", "ok");
    } else {
      drawStamp();
    }
  } catch (e) { /* the server going away for a moment is fine */ }
}

async function doRefresh(full) {
  if (S.offline) {
    toast("This is a saved snapshot. Run the server to collect fresh data.");
    return;
  }
  if (S.busy) { toast("A collection is already running."); return; }
  S.busy = true;
  $("refresh").classList.remove("turn");    // the run takes the turning over
  $("refresh").classList.add("spin");
  $("bar").classList.remove("hidden");
  drawStamp();
  toast(full ? "Full rescan started, this takes a few minutes\u2026"
             : "Reading lore, patchwork and git.kernel.org\u2026");
  try {
    const r = await post("/api/refresh" + (full ? "?full=1" : ""));
    if (r.status === 401) { location.href = "/login"; return; }
    const body = await r.json();
    if (!body.ok) throw new Error(body.error || "the collector failed");
    await load();
    render();
    toast(body.summary, "ok");
  } catch (e) {
    toast(String(e.message || e), "bad");
  } finally {
    S.busy = false;
    $("refresh").classList.remove("spin");
    $("bar").classList.add("hidden");
    pollStatus();
  }
}

async function pushAuto(on, interval) {
  const r = await post("/api/auto", { on, interval });
  const body = await r.json();
  S.status.auto = body.auto;
  S.status.interval = body.interval;
  await pollStatus();
  render();
  return body;
}

async function setAuto(on) {
  const body = await pushAuto(on, S.status.interval || 15);
  toast(on ? `Refreshing every ${prettyInterval(body.interval)}.`
           : "Automatic refresh is off.");
}

/* The one thing this dashboard will send unasked, so it is off until it is
   asked for and says plainly what turning it on means. */
async function setMergedMail(on) {
  try {
    const r = await post("/api/prefs", { merged_mail: !!on });
    const body = await r.json();
    if (!body.ok) { toast(body.error || "Could not save that.", "bad"); return; }
    S.status.merged_mail = !!(body.prefs && body.prefs.merged_mail);
    toast(S.status.merged_mail
      ? "We will write when a patch of yours reaches mainline."
      : "No more mail about patches landing.");
    render();
  } catch (e) {
    toast("Could not reach the dashboard.", "bad");
  }
}

async function setInterval_(minutes) {
  const body = await pushAuto(true, minutes);
  toast(`Refreshing every ${prettyInterval(body.interval)}.`);
}

async function applyInterval() {
  const box = $("ivnum");
  const v = Number(box ? box.value : 0);
  if (!v || v < 1 || v > 10080) {
    toast("Pick anything from 1 minute to 10080 (a week).", "bad");
    return;
  }
  await setInterval_(v);
}

/* ------------------------------------------------------------------ boot */

/* ------------------------------------------------------------ appearance

   Four things, and every one of them starts where it started before any of
   this existed: the dark palette, the lighter glass, no wallpaper.  Nobody
   who does not open Settings sees any change at all, which is the whole
   arrangement -- a tracker somebody reads all day should not have decided
   for them that it wants to be looked at.

   The palette follows the account, because it is a preference about the
   product and the same person on another machine means the same thing by
   it.  An uploaded wallpaper does not: it is a file off one device, it is
   megabytes, and sending it to a server so it can come back again is a
   cost nobody asked for.  So the picture stays in the browser it was
   chosen in, and only the fact that one was chosen travels. */

function appearanceBox() {
  const L = look();
  const theme = document.documentElement.dataset.theme || "dark";
  const clear = L.clarity == null ? "" : L.clarity;
  const shown = L.clarity == null ? "Auto" : L.clarity + "%";
  const custom = wallImage();

  const swatch = ([key, name]) =>
    `<button class="wsw ${L.wall === key ? "on" : ""}" data-w="${esc(key)}"
      ${act(setWall, key)} aria-pressed="${L.wall === key}"
      ><span>${esc(name)}</span></button>`;

  return `
  <div class="field">
    <label>Theme</label>
    <div class="presets">
      ${THEMES.map(([k, name]) => `<button class="chip ${
        theme === k ? "on" : ""}" ${act(setTheme, k)}>${esc(name)}</button>`)
        .join("")}
    </div>
    <p class="hint">Remembered against your account.
      ${info("theme", `So it follows you to another machine rather than
      living in this browser alone, the way a setting kept in the browser
      would. None of the six changes what a colour means: green is a patch
      that landed on every one of them.`)}</p>
  </div>

  <div class="field">
    <label>Glass</label>
    <div class="presets">
      ${SKINS.map(([k, name]) => `<button class="chip ${
        L.skin === k ? "on" : ""}" ${act(setSkin, k)}>${esc(name)}</button>`)
        .join("")}
    </div>
    <p class="hint">Liquid blurs harder and rounds the corners further.
      ${info("skin", `Blur is the expensive part of glass: the browser has
      to read what is behind every pane and average it, on every frame that
      moves. Classic is the lighter of the two and is what this starts on.
      On an older laptop, or a long patch list, it is the one to stay on.`)}</p>
  </div>

  <div class="field">
    <label>Wallpaper</label>
    <div class="walls">
      ${WALLS.map(swatch).join("")}
      ${custom ? swatch(["custom", "Yours"]) : ""}
    </div>
    <label class="btn ghost sm upload">
      ${custom ? "Replace image" : "Upload an image"}
      <input type="file" accept="image/*" ${acte("change", wallUpload)}>
    </label>
    ${custom ? `<button class="btn ghost sm" ${act(clearWall)}
      >Remove yours</button>` : ""}
    <p class="hint">The six above are drawn, not photographs, so they cost
      nothing to load and suit every palette.
      ${info("wall", `An image you upload is scaled down and kept in this
      browser, not sent anywhere: it is your file, it is megabytes, and a
      server has no use for it. That does mean it is on this machine only,
      and that clearing site data takes it with it.`)}</p>
  </div>

  <div class="field">
    <label>Transparency</label>
    <div class="slider">
      <input type="range" min="18" max="96" step="1"
        value="${clear === "" ? 46 : clear}"
        aria-label="How much shows through the panels"
        ${actv("input", setClarity)}>
      <output>${esc(shown)}</output>
    </div>
    <p class="hint">How much of what is behind a panel comes through it.
      ${info("clarity", `Lower is clearer. Text has to stay readable on top
      of whatever is behind it, so the far end of this is further than most
      pages will want, and over a photograph the veil behind everything is
      thickened to compensate.`)}</p>
  </div>`;
}

const THEMES = [
  ["dark", "Dark"], ["midnight", "Midnight"], ["graphite", "Graphite"],
  ["ocean", "Ocean"], ["light", "Light"], ["paper", "Paper"],
];

/* Which of them are light.  The header button is a two-way switch across
   six palettes, so it has to ask what sort of place it is in rather than
   compare against "dark": from Graphite it should go to the light one,
   and from Paper back to the dark one. */
const LIGHT = new Set(["light", "paper"]);

const SKINS = [["classic", "Classic"], ["liquid", "Liquid"]];

const WALLS = [
  ["", "None"], ["aurora", "Aurora"], ["dusk", "Dusk"], ["tide", "Tide"],
  ["forest", "Forest"], ["ember", "Ember"], ["slate", "Slate"],
];

const LOOK_KEY = "patchvane-look";
/* Kept apart from the rest: it is the one that is megabytes, and reading
   the small settings should not mean parsing an image out of them. */
const WALL_KEY = "patchvane-wallpaper";

const LOOK_BASE = { skin: "classic", wall: "", clarity: null };

function look() {
  if (!S.look) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LOOK_KEY) || "{}"); }
    catch (e) { saved = {}; }
    S.look = Object.assign({}, LOOK_BASE, saved);
  }
  return S.look;
}

function wallImage() {
  try { return localStorage.getItem(WALL_KEY) || ""; } catch (e) { return ""; }
}

function applyLook() {
  const L = look(), root = document.documentElement;

  if (L.skin === "liquid") root.dataset.skin = "liquid";
  else delete root.dataset.skin;

  /* "Custom" with nothing stored is what a browser looks like after its
     storage was cleared, or on the second machine.  Fall back rather than
     show a wallpaper layer with no wallpaper in it. */
  const custom = wallImage();
  const wall = (L.wall === "custom" && !custom) ? "" : L.wall;
  if (wall) root.dataset.wall = wall; else delete root.dataset.wall;
  if (custom) root.style.setProperty("--wall-custom", `url("${custom}")`);
  else root.style.removeProperty("--wall-custom");

  if (L.clarity == null) root.style.removeProperty("--glass-pc");
  else root.style.setProperty("--glass-pc", L.clarity + "%");

  /* How much of the wallpaper to cover so the page can be read on top of
     it. Clearer panels need more of this, since their text is sitting on
     the picture rather than on them -- but not much more: the first try at
     this was heavy enough to turn every wallpaper back into the plain dark
     page, which is a way of having the feature without giving it. */
  const clear = L.clarity == null ? 46 : L.clarity;
  /* A photograph gets a little more of it than the drawn six do. Those
     were built to be dark where the text is; somebody's own picture has a
     white sky in it somewhere, and that is where the heading lands. */
  const veil = 52 - clear * 0.42 + (wall === "custom" ? 11 : 0);
  root.style.setProperty("--veil",
    Math.max(10, Math.min(62, Math.round(veil))) + "%");
}

function saveLook(patch) {
  Object.assign(look(), patch);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look())); }
  catch (e) { /* nothing kept, but the page still looks right until reload */ }
  applyLook();
  post("/api/prefs", { look: look() }).catch(() => {});
}

function setSkin(next) { saveLook({ skin: next }); render(); }
function setWall(next) { saveLook({ wall: next }); render(); }

/* No render: this one is dragged, and rebuilding the page under the thumb
   would take the thumb with it. The reading beside it is moved by hand. */
function setClarity(value) {
  const n = Math.round(Number(value) || 0);
  saveLook({ clarity: n });
  const out = document.querySelector(".slider output");
  if (out) out.textContent = n + "%";
}

function clearWall() {
  try { localStorage.removeItem(WALL_KEY); } catch (e) { /* already gone */ }
  saveLook({ wall: "" });
  render();
}

/* An uploaded wallpaper, made small enough to keep.

   Straight off a phone this is a twelve megapixel JPEG, and localStorage
   is about five megabytes for everything this dashboard remembers.  It is
   a background: it never needs more pixels than the widest screen it will
   be stretched across, and nobody is going to examine it.  So it is drawn
   into a canvas at a sane size and re-encoded, dropping the quality a step
   at a time until it fits rather than guessing one number for every
   photograph. */
function wallUpload(el) {
  const file = el.files && el.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    toast("That file is not an image");
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    URL.revokeObjectURL(url);
    const max = 2560;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);

    let data = "";
    for (const q of [0.82, 0.7, 0.58, 0.45, 0.32]) {
      data = c.toDataURL("image/jpeg", q);
      if (data.length < 3200000) break;
    }
    try {
      localStorage.setItem(WALL_KEY, data);
    } catch (e) {
      toast("No room left to keep that image");
      return;
    }
    saveLook({ wall: "custom" });
    render();
    toast("Wallpaper set");
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast("That image could not be read");
  };
  img.src = url;
}

/* Not through transition(), and this is the one change on the page that
   must not be.  A view transition works by holding a still picture of the
   document over the top while it crossfades, and for as long as that
   picture is up nothing underneath is drawn -- including the button that
   was just pressed.  The moon would sit frozen for the length of the fade
   and then appear as a sun, which is the one thing the animation exists to
   avoid.  Changing the colours in place and letting the elements' own
   transitions carry it gets the same crossfade and leaves the button
   free to move. */
function setTheme(next) {
  paintThemeBtn(next);
  if (document.documentElement.dataset.theme === next) return;
  tinting();
  document.documentElement.dataset.theme = next;
  /* Locally so the next paint on this machine has it before the server
     answers, and on the server so the next machine starts the same way. */
  localStorage.setItem("patchvane-theme", next);
  /* A frame behind the rest.  Rebuilding this page is a few hundred
     milliseconds of blocked main thread on a large collection, and doing
     it in the same tick as the class change spends that time out of the
     middle of the button's animation -- the colours change, the moon
     holds still, and then it is a sun.  The colours are CSS variables and
     have already taken; this is only for the charts that bake them in. */
  requestAnimationFrame(() => requestAnimationFrame(render));
  post("/api/prefs", { theme: next }).catch(() => {});
}

/* Colour is not normally transitioned on everything at once -- it is a lot
   of elements and it would smear every hover -- so it is switched on for
   as long as the change takes and then switched off again. */
let TINT_OFF = null;
function tinting() {
  const root = document.documentElement;
  root.classList.add("tinting");
  clearTimeout(TINT_OFF);
  TINT_OFF = setTimeout(() => root.classList.remove("tinting"), 480);
}

/* Which way the button is drawn, set on the button itself rather than read
   off the theme on <html>.

   Changing the theme runs the whole page through a view transition, and a
   view transition works by holding a picture of the old page over the new
   one until the crossfade finishes.  Anything keyed off data-theme is in
   that picture, so the moon would sit still for the length of the fade and
   then jump.  Given its own class, applied before any of that starts, the
   button moves on the press and the page catches up behind it. */
function paintThemeBtn(theme) {
  const b = $("theme");
  if (b) b.classList.toggle("sun", LIGHT.has(theme));
}

/* The moon opening into a sun is the shape; the warmth on the way is the
   colour, and it comes off once the shape has settled so the button goes
   back to being part of the header. */
function toggleTheme() {
  const b = $("theme");
  const next = LIGHT.has(document.documentElement.dataset.theme)
    ? "dark" : "light";
  b.classList.add("flip");
  setTimeout(() => b.classList.remove("flip"), 620);
  paintThemeBtn(next);
  setTheme(next);
}

/* Escape only.  This was a page of single-letter shortcuts -- a for the
   assistant, r to refresh, digits for the sections -- which meant every
   stray keypress outside a text box did something, and the only way to
   find out what was a card in the corner explaining them. Escape is not a
   shortcut in that sense: it is how anything that opened over the page
   gets closed, and nobody has to be told. */
function keys(e) {
  if (e.key !== "Escape") return;
  if ($("thread").classList.contains("open")) { closeThread(); return; }
  if ($("ai").classList.contains("open")) { closeAI(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) e.target.blur();
}

async function boot() {
  document.documentElement.dataset.theme =
    localStorage.getItem("patchvane-theme") || "dark";
  paintThemeBtn(document.documentElement.dataset.theme);
  applyLook();

  bindHandlers();

  /* The shell lives outside every render, so it is wired once and directly
     rather than through the command map, which render() empties. */
  /* One turn on the press, whatever comes of it.  A collection can take
     a second to start and can also be refused -- already running, saved
     snapshot -- and a button that sits still until the server answers
     feels broken in both cases. */
  $("refresh").addEventListener("click", () => {
    const b = $("refresh");
    b.classList.remove("turn");
    void b.offsetWidth;                     // so a second press restarts it
    b.classList.add("turn");
    doRefresh(false);
  });
  $("theme").addEventListener("click", toggleTheme);
  $("aibtn").addEventListener("click", () => askAI());
  $("aiclose").addEventListener("click", closeAI);
  $("ainew").addEventListener("click", newChat);
  $("aipast").addEventListener("click", toggleHistory);
  $("aiscrim").addEventListener("click", closeAI);
  $("thclose").addEventListener("click", closeThread);
  $("thscrim").addEventListener("click", closeThread);
  $("aisend").addEventListener("click", sendAI);
  /* The corner menu: everything about you rather than about your patches,
     which is why Settings moved here off the sidebar. Sign out lives behind
     it too, rather than one stray click away from ending the session. */
  $("whobtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWhoMenu();
  });
  $("whomenu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-who]");
    if (!b) return;
    toggleWhoMenu(false);
    if (b.dataset.who === "signout") signOut();
    else go(b.dataset.who);
  });
  /* A menu that will not close is worse than no menu. */
  document.addEventListener("click", () => toggleWhoMenu(false));
  /* Enter in a Discover search box means search, because pressing it and
     having nothing happen is what every search box has taught people not to
     expect.  The author box has a suggestion list under it, so there Enter
     and the arrows go to whichever of the two is showing. */
  document.addEventListener("keydown", (e) => {
    const box = e.target.closest && e.target.closest("input[data-find]");
    if (!box) return;
    if (box.dataset.find === "q") { findKeys(e); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    S.find[box.dataset.find] = box.value;
    findSend();
  });
  /* Type-ahead for the author box only: the other box searches MAINTAINERS
     by path, which is a different kind of question with no people in it. */
  document.addEventListener("input", (e) => {
    const box = e.target.closest && e.target.closest("input[data-find='q']");
    if (box) findSuggest(box.value);
  });
  /* Clicking anywhere else puts the list away. */
  document.addEventListener("click", (e) => {
    if (!S.find.sugOpen) return;
    if (e.target.closest && e.target.closest(".findbox")) return;
    S.find.sugOpen = false;
    drawSuggest();
  });
  $("aiinput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAI(); }
  });
  $("aiinput").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
  });
  document.addEventListener("keydown", keys);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(mountCharts, 150);
  });
  window.addEventListener("hashchange", () => {
    const v = location.hash.replace("#", "");
    if (v && v !== S.view) go(v);
  });

  /* collect.py --standalone bakes the data into a single file that answers to
     nobody: no server, no sign-in, no refreshing. */
  S.offline = !!window.__DATA__;
  if (S.offline) document.body.classList.add("offline");

  await pollStatus();
  if (!S.offline) await loadProviders();
  /* Asked at the start rather than when the Settings page is opened,
     because whether this account runs the deployment decides whether there
     is a section in the sidebar at all, and a section that appears only
     after you have been somewhere else is a section nobody finds. */
  if (!S.offline) loadSupport();

  /* Put the last known page up straight away, before asking for a fresh
     one, so signing in lands on the dashboard rather than on a spinner. */
  const cached = S.offline ? null : snapLoad((S.status && S.status.who) || "");
  if (cached) {
    S.data = cached;
    S.view = location.hash.replace("#", "") || "overview";
    render();
    $("bar").classList.add("hidden");
  }

  try {
    if (S.offline) S.data = window.__DATA__;
    else if (!(await load())) return;
  } catch (e) {
    /* A snapshot on screen is better than replacing it with an error. */
    if (cached) {
      toast("Showing the last page saved in this browser.");
      return;
    }
    $("view").innerHTML = `<div class="panel"><div class="empty">
      <div class="emptyicon">\u23F3</div><p>${esc(e.message)}</p></div></div>`;
    $("bar").classList.add("hidden");
    return;
  }

  S.view = location.hash.replace("#", "") || "overview";
  render();
  $("bar").classList.add("hidden");

  if (!S.offline) {
    setInterval(drawStamp, 20000);
    pollLoop();
  }
}

boot();
