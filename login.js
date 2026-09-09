/* Sign-in page. Kept out of the markup so the page needs no inline script,
   which is what lets the server send a Content-Security-Policy without
   'unsafe-inline'. */

(function () {
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  if (params.get("error")) {
    $("err").textContent = params.get("error");
    $("err").classList.remove("hidden");
  }

  const LEAD = {
    gmail: "Your Gmail address and a Google app password. They go straight to "
         + "Gmail to be checked, and are not stored.",
    passphrase: "The passphrase set when this was deployed.",
    both: "This server wants both: your Gmail app password, and the passphrase "
        + "set when it was deployed.",
  };

  let mode = { gmail: true, passphrase: false, both: false };
  let using = "gmail";

  /* A field the server is not going to look at should not be submitted and
     should not hold up the browser's own validation. */
  function fields(box, on) {
    box.classList.toggle("hidden", !on);
    box.querySelectorAll("input").forEach((i) => {
      /* Which address to track can be left blank when the server already
         has one, so the browser must not insist on it. */
      i.required = !!on && !i.dataset.optional;
      i.disabled = !on;
    });
  }

  function paint() {
    const both = mode.both && mode.gmail && mode.passphrase;
    fields($("gmailfields"), both || (mode.gmail && using === "gmail"));
    fields($("passfield"), both || (mode.passphrase && using === "passphrase"));

    $("method").value = both ? "both" : using;
    $("lead").textContent = both ? LEAD.both : LEAD[using];
    $("note").classList.toggle("hidden", !(both || using === "gmail"));

    /* Only worth offering the choice when there is one. */
    const choose = !both && mode.gmail && mode.passphrase;
    $("pick").classList.toggle("hidden", !choose);
    $("pick").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.method === using);
    });

    const first = [...document.querySelectorAll(".loginbox input")]
      .find((i) => !i.disabled && i.type !== "hidden");
    if (first) first.focus();
  }

  $("pick").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-method]");
    if (!b) return;
    using = b.dataset.method;
    $("err").classList.add("hidden");
    paint();
  });

  document.querySelector("form").addEventListener("submit", () => {
    const b = $("go");
    b.disabled = true;
    b.textContent = "Checking\u2026";
  });

  /* The server decides what it will accept, so ask rather than guess and put
     up a field that does nothing. */
  fetch("/api/signin", { cache: "no-store" })
    .then((r) => r.json())
    .then((m) => {
      mode = m;
      using = m.gmail ? "gmail" : "passphrase";
      paint();
    })
    .catch(() => paint());
}());
