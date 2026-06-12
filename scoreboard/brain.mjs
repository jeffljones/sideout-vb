/* SIDEOUT scoreboard brain — reference reader for LED scoreboards.
   One process per event: subscribes to the event, results, and live
   scores, derives the current match per court, and re-renders on every
   change. Replace render() with your fan-out to the boards (serial,
   UDP, MQTT — whatever the ESP32s speak).

     usage: node scoreboard/brain.mjs CODE

   Runs anywhere Node 18+ runs (a Pi included). Uses the same Firebase
   config and store layer as the app. Total Firestore cost: one doc read
   per score change for this single client — noise on the free tier.

   NOTE: live scores only flow once the `live` block in firestore.rules
   is published; until then boards show 0–0 during play and the final
   when it lands. */

import * as store from "../src/store.js";
import { matchDone, sideLabel } from "../src/engine.js";

const code = (process.argv[2] || "").toUpperCase();
if (!/^[A-Z]{4}$/.test(code)) {
  console.error("usage: node scoreboard/brain.mjs CODE   (4-letter event code)");
  process.exit(1);
}

let cfg = null;
let res = {};
let live = {};

// One entry per court: the match that should be on that net right now.
function courtState() {
  if (!cfg || cfg.status === "signup") return [];
  const out = [];
  for (let ct = 1; ct <= cfg.courts; ct++) {
    const queue = cfg.sched.filter((m) => m.ct === ct && !matchDone(m, res));
    const m = queue[0];
    if (!m) { out.push({ ct, idle: true }); continue; }
    const lv = live[m.id] || {};
    out.push({
      ct,
      matchId: m.id,
      label: m.lbl || `ROUND ${m.rd}`,
      game: lv.g || 1,
      bo: m.bo || 1,
      a: { name: sideLabel(cfg, m.a), score: lv.a ?? 0 },
      b: { name: sideLabel(cfg, m.b), score: lv.b ?? 0 },
      next: queue[1]
        ? `${sideLabel(cfg, queue[1].a)} vs ${sideLabel(cfg, queue[1].b)}`
        : null,
    });
  }
  return out;
}

/* >>> Replace this with your LED fan-out. <<<
   courtState() gives you everything a board needs, already per court. */
function render() {
  console.clear();
  console.log(`SIDEOUT ${code} — ${cfg ? cfg.name : "connecting…"}`);
  for (const c of courtState()) {
    if (c.idle) { console.log(`  CT${c.ct}  — no match queued —`); continue; }
    const g = c.bo > 1 ? ` G${c.game}` : "";
    console.log(`  CT${c.ct}  [${c.label}${g}]  ${c.a.name}  ${String(c.a.score).padStart(2)} – ${String(c.b.score).padEnd(2)}  ${c.b.name}`);
    if (c.next) console.log(`        next: ${c.next}`);
  }
}

store.subscribeEvent(code, (d) => {
  if (!d) { console.error(`No event ${code} (deleted?)`); process.exit(1); }
  cfg = d; render();
}, (e) => console.error("cfg listener:", e.code || e));
store.subscribeResults(code, (r) => { res = r; render(); },
  (e) => console.error("results listener:", e.code || e));
store.subscribeLive(code, (l) => { live = l; render(); },
  (e) => console.error("live listener (rules block published?):", e.code || e));
