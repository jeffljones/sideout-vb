import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* =====================================================================
   SIDEOUT — volleyball tournament day engine
   Formats: fixed-team round robin · rotating pairs (4s) · pickup mix
   Multi-phone sync via shared artifact storage.
   ===================================================================== */

const C = {
  paper: "#FCF8EF",
  ink: "#11253F",
  dim: "#5C6B7E",
  line: "#E3DAC6",
  accent: "#FF4F1F",
  accentSoft: "#FFE6DD",
  green: "#1C7C54",
  greenSoft: "#E2F2E9",
  gold: "#C8930A",
  card: "#FFFFFF",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const CSS = `
  .pressable{transition:transform .06s ease, box-shadow .06s ease;}
  .pressable:active{transform:translate(2px,2px);box-shadow:1px 1px 0 ${C.ink} !important;}
  button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid ${C.accent};outline-offset:2px;}
  @media (prefers-reduced-motion: reduce){*{transition:none !important;animation:none !important;}}
  .blink{animation:so-blink 1.6s ease-in-out infinite;}
  @keyframes so-blink{50%{opacity:.3;}}
  input,select,button{font:inherit;}
  *{-webkit-tap-highlight-color:transparent;}
`;

/* ---------------------- storage helpers ---------------------- */
const NS = "vb1";
const kCfg = (c) => `${NS}:${c}:cfg`;
const kRegP = (c) => `${NS}:${c}:reg:`;
const kDoneP = (c) => `${NS}:${c}:done:`;
const kIdxP = `${NS}:idx:`;
const kMe = (c) => `${NS}:${c}:me`;
const kAdmin = (c) => `${NS}:${c}:apin`;

async function sGet(key, shared = true) {
  try { const r = await window.storage.get(key, shared); return r ? r.value : null; }
  catch (e) { return null; }
}
async function sSet(key, value, shared = true) {
  try { await window.storage.set(key, value, shared); return true; }
  catch (e) { console.error("set failed", key, e); return false; }
}
async function sDel(key, shared = true) {
  try { await window.storage.delete(key, shared); } catch (e) {}
}
async function sList(prefix, shared = true) {
  try { const r = await window.storage.list(prefix, shared); return r && r.keys ? r.keys : []; }
  catch (e) { return []; }
}

/* ---------------------- codecs ---------------------- */
const enc = (s) =>
  (s || "").trim().replace(/[~'"/\\\s]+/g, "_").replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 24) || "Player";
const dec = (s) => (s || "").replace(/_/g, " ");
const uid = () => Math.random().toString(36).slice(2, 8);
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const newCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

// reg key:  vb1:CODE:reg:TS~Name~Extra
function parseRegKey(key, code) {
  const tail = key.slice(kRegP(code).length);
  const parts = tail.split("~");
  if (parts.length < 2) return null;
  return { key, ts: Number(parts[0]) || 0, name: dec(parts[1]), extra: dec(parts[2] || "") };
}
// done key: vb1:CODE:done:MID~A-B~TS
function parseDoneKey(key, code) {
  const tail = key.slice(kDoneP(code).length);
  const parts = tail.split("~");
  if (parts.length < 3) return null;
  const sc = parts[1].split("-");
  return { key, mid: parts[0], a: Number(sc[0]) || 0, b: Number(sc[1]) || 0, ts: Number(parts[2]) || 0 };
}
// idx key:  vb1:idx:CODE~Name~CreatedMs
function parseIdxKey(key) {
  const tail = key.slice(kIdxP.length);
  const parts = tail.split("~");
  if (parts.length < 3) return null;
  return { key, code: parts[0], name: dec(parts[1]), created: Number(parts[2]) || 0 };
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pk = (x, y) => (x < y ? x + "|" + y : y + "|" + x);

/* ---------------------- config shape ----------------------
   cfg = { v, code, name, format: 'teams'|'pairs'|'mix', teamSize,
           courts, pointsTo, pin, status: 'signup'|'live'|'done',
           created, roster:[{id,name}], groups:[{id,name,players:[pid]}]|null,
           sched:[{id, rd, ct, a, b}], rds, mseq,
           byes:{rd:[groupId|pid,...]}, sit:{rd:[pid,...]},
           inact:[ids], sat:{pid:n} }
   side = {g:[groupId,...]} for teams/pairs, {p:[pid,...]} for mix
------------------------------------------------------------- */

const nameOf = (cfg, pid) => (cfg.roster.find((r) => r.id === pid) || {}).name || "?";
const groupOf = (cfg, gid) => (cfg.groups || []).find((g) => g.id === gid);
function groupLabel(cfg, gid) {
  const g = groupOf(cfg, gid);
  if (!g) return "?";
  if (cfg.format === "pairs") return g.players.map((p) => nameOf(cfg, p)).join("/") || g.name;
  return g.name;
}
function sideLabel(cfg, side) {
  if (side.p) return side.p.map((p) => nameOf(cfg, p)).join(" · ");
  return side.g.map((gid) => groupLabel(cfg, gid)).join("  +  ");
}
function sideStatIds(cfg, side) {
  return side.p ? side.p : side.g;
}
function sidePlayerIds(cfg, side) {
  if (side.p) return side.p;
  return side.g.flatMap((gid) => (groupOf(cfg, gid) || { players: [] }).players);
}

/* ---------------------- history (variety) ---------------------- */
function buildHist(cfg) {
  const tm = new Map(); // teammate counts
  const op = new Map(); // opponent counts
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const match of cfg.sched) {
    const A = sideStatIds(cfg, match.a);
    const B = sideStatIds(cfg, match.b);
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) bump(tm, pk(A[i], A[j]));
    for (let i = 0; i < B.length; i++)
      for (let j = i + 1; j < B.length; j++) bump(tm, pk(B[i], B[j]));
    for (const x of A) for (const y of B) bump(op, pk(x, y));
  }
  return { tm, op };
}

/* ---------------------- round robin (fixed teams) ---------------------- */
function genRoundRobin(cfg) {
  const ids = cfg.groups.map((g) => g.id);
  const arr = [...ids];
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  const sched = [];
  const byes = {};
  let seq = cfg.mseq || 0;
  for (let r = 0; r < n - 1; r++) {
    const rd = r + 1;
    let courtIdx = 0;
    for (let i = 0; i < n / 2; i++) {
      const x = arr[i], y = arr[n - 1 - i];
      if (x === null || y === null) {
        const real = x === null ? y : x;
        byes[rd] = [...(byes[rd] || []), real];
        continue;
      }
      sched.push({
        id: "m" + ++seq, rd,
        ct: (courtIdx++ % cfg.courts) + 1,
        a: { g: [x] }, b: { g: [y] },
      });
    }
    arr.splice(1, 0, arr.pop());
  }
  return { ...cfg, sched, byes, rds: n - 1, mseq: seq };
}

/* ---------------------- rotating pairs: next round ---------------------- */
function genPairsRound(cfg) {
  const byeCount = (gid) =>
    Object.values(cfg.byes || {}).reduce((acc, list) => acc + (list.includes(gid) ? 1 : 0), 0);
  const active = cfg.groups.map((g) => g.id).filter((gid) => !(cfg.inact || []).includes(gid));
  if (active.length < 2) return { cfg, error: "Need at least 2 active pairs." };
  const { tm, op } = buildHist(cfg);
  // most-benched pairs play first; least-benched sit if numbers are odd
  const order = shuffle(active).sort((a, b) => byeCount(b) - byeCount(a));
  const rd = (cfg.rds || 0) + 1;
  let seq = cfg.mseq || 0;
  const matches = [];
  const byesNow = [];
  const rem = order.length % 4;
  let playPool = [...order];
  let tail = [];
  if (rem === 1 || rem === 3) {
    byesNow.push(playPool.pop()); // sat least recently
  }
  if ((playPool.length % 4) === 2) {
    tail = playPool.splice(playPool.length - 2, 2); // head-to-head 2v2
  }
  for (let i = 0; i < playPool.length; i += 4) {
    const [w, x, y, z] = playPool.slice(i, i + 4);
    const splits = [
      [[w, x], [y, z]],
      [[w, y], [x, z]],
      [[w, z], [x, y]],
    ];
    let best = null, bestCost = Infinity;
    for (const s of splits) {
      const tCost = (tm.get(pk(s[0][0], s[0][1])) || 0) + (tm.get(pk(s[1][0], s[1][1])) || 0);
      let oCost = 0;
      for (const x1 of s[0]) for (const y1 of s[1]) oCost += op.get(pk(x1, y1)) || 0;
      const cost = tCost * 10 + oCost;
      if (cost < bestCost) { bestCost = cost; best = s; }
    }
    matches.push({ id: "m" + ++seq, rd, ct: 0, a: { g: best[0] }, b: { g: best[1] } });
  }
  if (tail.length === 2) {
    matches.push({ id: "m" + ++seq, rd, ct: 0, a: { g: [tail[0]] }, b: { g: [tail[1]] } });
  }
  matches.forEach((m, i) => { m.ct = (i % cfg.courts) + 1; });
  return {
    cfg: {
      ...cfg,
      sched: [...cfg.sched, ...matches],
      byes: { ...(cfg.byes || {}), ...(byesNow.length ? { [rd]: byesNow } : {}) },
      rds: rd, mseq: seq,
    },
  };
}

/* ---------------------- pickup mix: next round ---------------------- */
function genMixRound(cfg) {
  const sat = cfg.sat || {};
  const active = cfg.roster.map((r) => r.id).filter((pid) => !(cfg.inact || []).includes(pid));
  if (active.length < 4) return { cfg, error: "Need at least 4 active players." };
  const { tm } = buildHist(cfg);
  const K = cfg.teamSize;
  // players who have sat the most go in first
  const order = shuffle(active).sort((a, b) => (sat[b] || 0) - (sat[a] || 0));
  let per = 2 * K;
  let nMatches = Math.min(cfg.courts, Math.floor(order.length / per));
  let size = K;
  if (nMatches === 0) { // small group: shrink the teams instead of skipping the round
    size = Math.min(K, Math.floor(order.length / 2));
    per = 2 * size;
    nMatches = 1;
  }
  const playing = order.slice(0, nMatches * per);
  const sitting = order.slice(nMatches * per);
  const rd = (cfg.rds || 0) + 1;
  let seq = cfg.mseq || 0;
  const matches = [];
  for (let mIdx = 0; mIdx < nMatches; mIdx++) {
    const pool = shuffle(playing.slice(mIdx * per, (mIdx + 1) * per));
    const A = [], B = [];
    for (const p of pool) {
      const costTo = (team) => team.reduce((acc, q) => acc + (tm.get(pk(p, q)) || 0), 0);
      if (A.length >= size) B.push(p);
      else if (B.length >= size) A.push(p);
      else {
        const ca = costTo(A), cb = costTo(B);
        if (ca < cb) A.push(p);
        else if (cb < ca) B.push(p);
        else (A.length <= B.length ? A : B).push(p);
      }
    }
    matches.push({ id: "m" + ++seq, rd, ct: (mIdx % cfg.courts) + 1, a: { p: A }, b: { p: B } });
  }
  const newSat = { ...sat };
  for (const pid of sitting) newSat[pid] = (newSat[pid] || 0) + 1;
  return {
    cfg: {
      ...cfg,
      sched: [...cfg.sched, ...matches],
      sit: { ...(cfg.sit || {}), ...(sitting.length ? { [rd]: sitting } : {}) },
      sat: newSat, rds: rd, mseq: seq,
    },
  };
}

/* ---------------------- standings ---------------------- */
function calcStandings(cfg, res) {
  const rows = new Map();
  const labelFor = (id) =>
    cfg.format === "mix" ? nameOf(cfg, id) : groupLabel(cfg, id);
  const ensure = (id) => {
    if (!rows.has(id)) rows.set(id, { id, label: labelFor(id), w: 0, l: 0, pf: 0, pa: 0, gp: 0 });
    return rows.get(id);
  };
  // seed every participant so 0-0 entries still show
  if (cfg.format === "mix") cfg.roster.forEach((r) => ensure(r.id));
  else (cfg.groups || []).forEach((g) => ensure(g.id));
  for (const m of cfg.sched) {
    const r = res[m.id];
    if (!r) continue;
    const A = sideStatIds(cfg, m.a), B = sideStatIds(cfg, m.b);
    const aWin = r.a > r.b;
    for (const id of A) { const row = ensure(id); row.gp++; row.pf += r.a; row.pa += r.b; aWin ? row.w++ : row.l++; }
    for (const id of B) { const row = ensure(id); row.gp++; row.pf += r.b; row.pa += r.a; aWin ? row.l++ : row.w++; }
  }
  return [...rows.values()].sort(
    (x, y) => y.w - x.w || (y.pf - y.pa) - (x.pf - x.pa) || y.pf - x.pf || x.label.localeCompare(y.label)
  );
}

/* ---------------------- roster → groups ---------------------- */
function buildPairs(roster, regs) {
  const byName = new Map(roster.map((r) => [r.name.toLowerCase(), r.id]));
  const wants = new Map(); // pid -> wanted pid
  for (const reg of regs) {
    const me = byName.get(reg.name.toLowerCase());
    const them = reg.extra ? byName.get(reg.extra.toLowerCase()) : null;
    if (me && them && them !== me) wants.set(me, them);
  }
  const free = new Set(roster.map((r) => r.id));
  const groups = [];
  const take = (a, b) => {
    free.delete(a); free.delete(b);
    groups.push({ id: uid(), name: "Pair " + (groups.length + 1), players: [a, b] });
  };
  for (const [a, b] of wants) // mutual requests first
    if (free.has(a) && free.has(b) && wants.get(b) === a) take(a, b);
  for (const [a, b] of wants) // then one-way requests
    if (free.has(a) && free.has(b)) take(a, b);
  const rest = shuffle([...free]);
  while (rest.length >= 2) take(rest.shift(), rest.shift());
  if (rest.length === 1) {
    groups.push({ id: uid(), name: "Solo", players: [rest.shift()] });
  }
  return groups;
}
function buildTeams(roster, regs, teamSize) {
  const byName = new Map(roster.map((r) => [r.name.toLowerCase(), r.id]));
  const named = new Map(); // teamname(lc) -> {label, players}
  const claimed = new Set();
  for (const reg of regs) {
    const pid = byName.get(reg.name.toLowerCase());
    if (!pid || !reg.extra) continue;
    const key = reg.extra.toLowerCase();
    if (!named.has(key)) named.set(key, { label: reg.extra, players: [] });
    if (named.get(key).players.length < teamSize) {
      named.get(key).players.push(pid);
      claimed.add(pid);
    }
  }
  const groups = [...named.values()].map((t) => ({ id: uid(), name: t.label, players: t.players }));
  const rest = shuffle(roster.map((r) => r.id).filter((pid) => !claimed.has(pid)));
  // top up short named teams first
  for (const g of groups) while (g.players.length < teamSize && rest.length) g.players.push(rest.shift());
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let li = 0;
  while (rest.length) {
    const chunk = rest.splice(0, teamSize);
    if (chunk.length === 1 && groups.length) {
      // don't strand one player on a team of one; ties go to auto-formed teams, not named ones
      groups.reduce((sm, g) => (g.players.length < sm.players.length ? g : sm), groups[groups.length - 1]).players.push(chunk[0]);
    } else {
      groups.push({ id: uid(), name: "Team " + letters[li++ % 26], players: chunk });
    }
  }
  return groups;
}

/* =====================================================================
   UI atoms
   ===================================================================== */
function Btn({ children, onClick, kind = "primary", disabled, style = {}, small }) {
  const base = {
    fontWeight: 800, border: `2px solid ${C.ink}`, borderRadius: 10,
    padding: small ? "8px 12px" : "14px 18px",
    fontSize: small ? 14 : 17, letterSpacing: "0.01em",
    boxShadow: `3px 3px 0 ${C.ink}`, cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1, color: C.ink, background: C.card,
    touchAction: "manipulation",
  };
  const kinds = {
    primary: { background: C.accent, color: "#fff" },
    ink: { background: C.ink, color: C.paper },
    ghost: { background: C.card },
    green: { background: C.green, color: "#fff" },
    danger: { background: "#fff", color: "#B3261E", borderColor: "#B3261E", boxShadow: "3px 3px 0 #B3261E" },
  };
  return (
    <button className="pressable" disabled={disabled} onClick={onClick}
      style={{ ...base, ...kinds[kind], ...style }}>
      {children}
    </button>
  );
}

function Card({ children, style = {}, accent }) {
  return (
    <div style={{
      background: C.card, border: `2px solid ${C.ink}`, borderRadius: 14,
      boxShadow: `4px 4px 0 ${C.ink}`, padding: 16,
      borderTop: accent ? `6px solid ${C.accent}` : `2px solid ${C.ink}`,
      ...style,
    }}>{children}</div>
  );
}

const Eyebrow = ({ children, style = {} }) => (
  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
    textTransform: "uppercase", color: C.dim, ...style }}>{children}</div>
);

function Field({ label, value, onChange, placeholder, maxLength, type = "text", hint, inputMode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Eyebrow style={{ marginBottom: 6, color: C.ink }}>{label}</Eyebrow>
      <input
        value={value} type={type} inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} maxLength={maxLength}
        style={{
          width: "100%", boxSizing: "border-box", padding: "13px 14px",
          border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 17,
          background: "#fff", color: C.ink,
        }}
      />
      {hint && <div style={{ fontSize: 12.5, color: C.dim, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function Stepper({ label, value, onChange, min = 1, max = 12 }) {
  const sq = {
    width: 46, height: 46, border: `2px solid ${C.ink}`, borderRadius: 10,
    background: "#fff", fontSize: 24, fontWeight: 800, color: C.ink,
    boxShadow: `2px 2px 0 ${C.ink}`,
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Eyebrow style={{ marginBottom: 6, color: C.ink }}>{label}</Eyebrow>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button className="pressable" style={sq} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
        <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, minWidth: 40, textAlign: "center" }}>{value}</div>
        <button className="pressable" style={sq} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
      </div>
    </div>
  );
}

function ChoiceRow({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={o.v} className="pressable" onClick={() => onChange(o.v)}
          style={{
            padding: "10px 14px", borderRadius: 10, border: `2px solid ${C.ink}`,
            fontWeight: 800, fontSize: 15,
            background: value === o.v ? C.ink : "#fff",
            color: value === o.v ? C.paper : C.ink,
            boxShadow: `2px 2px 0 ${C.ink}`,
          }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const CourtBadge = ({ n }) => (
  <span style={{
    fontFamily: MONO, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em",
    background: C.ink, color: C.paper, borderRadius: 7, padding: "4px 8px",
  }}>CT&nbsp;{n}</span>
);

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", bottom: 86, left: "50%", transform: "translateX(-50%)",
      background: C.ink, color: C.paper, padding: "10px 18px", borderRadius: 12,
      fontWeight: 700, fontSize: 14.5, zIndex: 60, maxWidth: "88%",
      boxShadow: `3px 3px 0 rgba(0,0,0,0.25)`, textAlign: "center",
    }}>{msg}</div>
  );
}

/* ---------------------- score modal ---------------------- */
function ScoreModal({ cfg, match, existing, onSave, onClear, onClose, canClear }) {
  const [a, setA] = useState(existing ? existing.a : 0);
  const [b, setB] = useState(existing ? existing.b : 0);
  const Pad = ({ val, set, label }) => (
    <div style={{ flex: 1, textAlign: "center" }}>
      <div style={{ fontWeight: 800, fontSize: 14.5, minHeight: 40, lineHeight: 1.25, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 56, fontWeight: 700, lineHeight: 1 }}>{val}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
        <button className="pressable" onClick={() => set(Math.max(0, val - 1))}
          style={{ width: 54, height: 54, fontSize: 26, fontWeight: 800, border: `2px solid ${C.ink}`, borderRadius: 12, background: "#fff", boxShadow: `2px 2px 0 ${C.ink}` }}>−</button>
        <button className="pressable" onClick={() => set(val + 1)}
          style={{ width: 54, height: 54, fontSize: 26, fontWeight: 800, border: `2px solid ${C.ink}`, borderRadius: 12, background: C.ink, color: C.paper, boxShadow: `2px 2px 0 ${C.ink}` }}>+</button>
      </div>
      <button className="pressable" onClick={() => set(cfg.pointsTo)}
        style={{ marginTop: 8, fontSize: 13, fontWeight: 800, padding: "6px 10px", border: `2px solid ${C.ink}`, borderRadius: 8, background: C.accentSoft, boxShadow: `2px 2px 0 ${C.ink}` }}>
        set {cfg.pointsTo}
      </button>
    </div>
  );
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(17,37,63,0.55)",
      display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.paper, borderTop: `3px solid ${C.ink}`,
        borderRadius: "20px 20px 0 0", padding: "20px 18px 28px",
        width: "100%", maxWidth: 560, boxSizing: "border-box",
      }}>
        <Eyebrow style={{ textAlign: "center", marginBottom: 4 }}>
          Round {match.rd} · Court {match.ct} · game to {cfg.pointsTo}
        </Eyebrow>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "10px 0 6px" }}>
          <Pad val={a} set={setA} label={sideLabel(cfg, match.a)} />
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, paddingTop: 56, color: C.dim }}>–</div>
          <Pad val={b} set={setB} label={sideLabel(cfg, match.b)} />
        </div>
        {a === b && (a > 0 || b > 0) && (
          <div style={{ color: "#B3261E", fontWeight: 700, fontSize: 13.5, textAlign: "center", marginBottom: 6 }}>
            No ties in volleyball — somebody won this one.
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Btn kind="ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
          <Btn kind="green" style={{ flex: 2 }} disabled={a === b}
            onClick={() => onSave(a, b)}>
            {existing ? "Update score" : "Save final score"}
          </Btn>
        </div>
        {existing && canClear && (
          <div style={{ marginTop: 10, textAlign: "center" }}>
            <Btn kind="danger" small onClick={onClear}>Clear result</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------- match card ---------------------- */
function MatchCard({ cfg, match, result, onTap, highlightIds }) {
  const done = !!result;
  const aIds = sidePlayerIds(cfg, match.a);
  const bIds = sidePlayerIds(cfg, match.b);
  const mine = highlightIds && (aIds.some((x) => highlightIds.has(x)) || bIds.some((x) => highlightIds.has(x)));
  const aWin = done && result.a > result.b;
  const Side = ({ side, score, win }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
      <div style={{
        fontWeight: win ? 800 : 600, fontSize: 16, lineHeight: 1.3,
        color: done && !win ? C.dim : C.ink, flex: 1,
      }}>
        {sideLabel(cfg, side)} {win && <span style={{ color: C.green }}>✓</span>}
      </div>
      {done && (
        <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: win ? C.ink : C.dim }}>
          {score}
        </div>
      )}
    </div>
  );
  return (
    <div onClick={onTap} className="pressable" style={{
      background: mine ? "#FFF4EF" : C.card,
      border: `2px solid ${C.ink}`, borderRadius: 12,
      boxShadow: `3px 3px 0 ${C.ink}`, padding: "10px 14px", marginBottom: 12,
      cursor: "pointer",
      borderLeft: done ? `6px solid ${C.green}` : `6px solid ${C.accent}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <CourtBadge n={match.ct} />
        {!done && <span className="blink" style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: C.accent }}>TAP TO SCORE</span>}
        {done && <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: C.green }}>FINAL</span>}
      </div>
      <Side side={match.a} score={done ? result.a : null} win={aWin} />
      <div style={{ borderTop: `1.5px dashed ${C.line}` }} />
      <Side side={match.b} score={done ? result.b : null} win={done && !aWin} />
    </div>
  );
}

function Shell({ toast, children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "18px 16px 110px" }}>{children}</div>
      <Toast msg={toast} />
    </div>
  );
}
function Logo({ small }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <div style={{ fontWeight: 900, fontSize: small ? 22 : 40, letterSpacing: "-0.03em", color: C.ink }}>
        SIDE<span style={{ color: C.accent }}>OUT</span>
      </div>
      {!small && <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>tournament day engine</div>}
    </div>
  );
}

/* =====================================================================
   Main app
   ===================================================================== */
const FORMATS = [
  { v: "teams", label: "Fixed teams · round robin", desc: "Set teams play everyone once. 2s–6s." },
  { v: "pairs", label: "Rotating pairs · 4s", desc: "Keep one partner all day; pairs combine into new 4s each round." },
  { v: "mix", label: "Pickup mix", desc: "Random teams every round; individual standings all day." },
];

export default function App() {
  const [view, setView] = useState("landing");
  const [recents, setRecents] = useState([]);
  const [joinInput, setJoinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  // event state
  const [code, setCode] = useState("");
  const [cfg, setCfg] = useState(null);
  const [regs, setRegs] = useState([]);
  const [res, setRes] = useState({});
  const [resAll, setResAll] = useState({});
  const [me, setMe] = useState("");
  const [adminOk, setAdminOk] = useState(false);
  const [tab, setTab] = useState("schedule");
  const [modal, setModal] = useState(null);
  const [lastSync, setLastSync] = useState(null);

  // forms
  const [fName, setFName] = useState("");
  const [fFormat, setFFormat] = useState("pairs");
  const [fTeamSize, setFTeamSize] = useState(2);
  const [fCourts, setFCourts] = useState(2);
  const [fPoints, setFPoints] = useState(21);
  const [fPin, setFPin] = useState("");
  const [regName, setRegName] = useState("");
  const [regExtra, setRegExtra] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [walkName, setWalkName] = useState("");
  const [walkName2, setWalkName2] = useState("");
  const [walkExtra, setWalkExtra] = useState("");
  const [meFilter, setMeFilter] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  // setup editor
  const [setupMode, setSetupMode] = useState(false);
  const [setupGroups, setSetupGroups] = useState([]);
  const [setupRoster, setSetupRoster] = useState([]);
  const [sel, setSel] = useState(null);

  const cfgRef = useRef(null);
  cfgRef.current = cfg;
  const codeRef = useRef("");
  codeRef.current = code;

  const say = (m) => { setToast(m); };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  /* -------------------- loading -------------------- */
  const loadRecents = useCallback(async () => {
    const keys = await sList(kIdxP);
    const items = keys.map(parseIdxKey).filter(Boolean)
      .sort((a, b) => b.created - a.created).slice(0, 8);
    setRecents(items);
  }, []);
  useEffect(() => { loadRecents(); }, [loadRecents]);

  const refresh = useCallback(async (showSpin) => {
    const c = codeRef.current;
    if (!c) return;
    if (showSpin) setBusy(true);
    const raw = await sGet(kCfg(c));
    if (!raw) { setBusy(false); return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { setBusy(false); return; }
    setCfg(parsed);
    if (parsed.status === "signup") {
      const keys = await sList(kRegP(c));
      const seen = new Map();
      keys.map((k) => parseRegKey(k, c)).filter(Boolean)
        .sort((a, b) => a.ts - b.ts)
        .forEach((r) => seen.set(r.name.toLowerCase(), r));
      setRegs([...seen.values()]);
    } else {
      const keys = await sList(kDoneP(c));
      const best = {}, all = {};
      for (const k of keys) {
        const d = parseDoneKey(k, c);
        if (!d) continue;
        (all[d.mid] = all[d.mid] || []).push(d);
        if (!best[d.mid] || d.ts > best[d.mid].ts) best[d.mid] = d;
      }
      setRes(best); setResAll(all);
    }
    setLastSync(new Date());
    setBusy(false);
  }, []);

  useEffect(() => {
    if (view !== "event") return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !setupMode) refresh(false);
    }, 20000);
    return () => clearInterval(t);
  }, [view, setupMode, refresh]);

  const joinEvent = async (c) => {
    const cc = (c || "").toUpperCase().trim();
    if (cc.length !== 4) { say("Codes are 4 letters."); return; }
    setBusy(true);
    const raw = await sGet(kCfg(cc));
    if (!raw) { setBusy(false); say(`No event found with code ${cc}.`); return; }
    setCode(cc); codeRef.current = cc;
    setCfg(JSON.parse(raw));
    const savedMe = await sGet(kMe(cc), false);
    if (savedMe) setMe(savedMe);
    const savedPin = await sGet(kAdmin(cc), false);
    const parsed = JSON.parse(raw);
    if (savedPin && savedPin === parsed.pin) setAdminOk(true); else setAdminOk(false);
    setTab("schedule"); setSetupMode(false); setModal(null); setConfirmDel(false);
    setView("event");
    await refresh(false);
    setBusy(false);
  };

  const leave = () => {
    setView("landing"); setCode(""); setCfg(null); setRegs([]); setRes({});
    setResAll({}); setMe(""); setAdminOk(false); setSetupMode(false);
    setJoinInput(""); setPinInput(""); loadRecents();
  };

  /* -------------------- create -------------------- */
  const createEvent = async () => {
    if (!fName.trim()) { say("Give the event a name."); return; }
    if (!/^\d{4}$/.test(fPin)) { say("Pick a 4-digit director PIN."); return; }
    setBusy(true);
    let c = newCode();
    for (let i = 0; i < 5; i++) {
      if (!(await sGet(kCfg(c)))) break;
      c = newCode();
    }
    const newCfg = {
      v: 1, code: c, name: fName.trim(), format: fFormat,
      teamSize: fFormat === "pairs" ? 2 : fTeamSize,
      courts: fCourts, pointsTo: fPoints, pin: fPin,
      status: "signup", created: Date.now(),
      roster: [], groups: null, sched: [], rds: 0, mseq: 0,
      byes: {}, sit: {}, inact: [], sat: {},
    };
    await sSet(kCfg(c), JSON.stringify(newCfg));
    await sSet(`${kIdxP}${c}~${enc(fName)}~${Date.now()}`, "1");
    await sSet(kAdmin(c), fPin, false);
    setCode(c); codeRef.current = c;
    setCfg(newCfg); setRegs([]); setAdminOk(true); setSetupMode(false);
    setView("event"); setBusy(false);
    say(`Event created — code ${c}`);
  };

  /* -------------------- signup -------------------- */
  const register = async () => {
    const nm = regName.trim();
    if (!nm) { say("Enter a name."); return; }
    if (regs.some((r) => r.name.toLowerCase() === nm.toLowerCase())) {
      say("That name's taken — add a last initial."); return;
    }
    setBusy(true);
    const ex = regExtra.trim() ? enc(regExtra) : "";
    await sSet(`${kRegP(code)}${Date.now()}~${enc(nm)}~${ex}`, "1");
    setRegName(""); setRegExtra("");
    await refresh(false);
    setBusy(false);
    say(`${nm} is in. 🏐`);
    if (!me) { setMe(nm); sSet(kMe(code), nm, false); }
  };

  const removeReg = async (r) => {
    await sDel(r.key);
    refresh(false);
  };

  // director adds a player on someone's behalf (no phone needed)
  const directorAdd = async () => {
    const nm = walkName.trim();
    if (!nm) { say("Enter a name."); return; }
    if (regs.some((r) => r.name.toLowerCase() === nm.toLowerCase())) {
      say("That name's already on the roster."); return;
    }
    setBusy(true);
    const ex = walkExtra.trim() ? enc(walkExtra) : "";
    await sSet(`${kRegP(code)}${Date.now()}~${enc(nm)}~${ex}`, "1");
    setWalkName(""); setWalkExtra("");
    await refresh(false);
    setBusy(false);
    say(`${nm} added to the roster.`);
  };

  const unlockAdmin = () => {
    if (pinInput === cfg.pin) {
      setAdminOk(true); setPinInput("");
      sSet(kAdmin(code), cfg.pin, false);
      say("Director controls unlocked.");
    } else say("Wrong PIN.");
  };

  /* -------------------- setup → start -------------------- */
  const startSetup = () => {
    const roster = regs.map((r) => ({ id: uid(), name: r.name }));
    if (cfg.format === "mix") {
      if (roster.length < 4) { say("Need at least 4 players."); return; }
      const live = { ...cfg, roster, status: "live", sat: Object.fromEntries(roster.map((r) => [r.id, 0])) };
      sSet(kCfg(code), JSON.stringify(live));
      setCfg(live); say("Event is live. Generate round 1 from Director.");
      setTab("admin");
      return;
    }
    const groups = cfg.format === "pairs"
      ? buildPairs(roster, regs)
      : buildTeams(roster, regs, cfg.teamSize);
    setSetupRoster(roster); setSetupGroups(groups); setSel(null); setSetupMode(true);
  };

  const reshuffleSetup = () => {
    const groups = cfg.format === "pairs"
      ? buildPairs(setupRoster, regs)
      : buildTeams(setupRoster, regs, cfg.teamSize);
    setSetupGroups(groups); setSel(null);
  };

  const tapChip = (pid) => {
    if (sel === pid) { setSel(null); return; }
    if (!sel) { setSel(pid); return; }
    // swap sel and pid across groups
    const gs = setupGroups.map((g) => ({ ...g, players: [...g.players] }));
    let gA = gs.find((g) => g.players.includes(sel));
    let gB = gs.find((g) => g.players.includes(pid));
    if (gA && gB) {
      const iA = gA.players.indexOf(sel), iB = gB.players.indexOf(pid);
      gA.players[iA] = pid; gB.players[iB] = sel;
      setSetupGroups(gs);
    }
    setSel(null);
  };

  const addSetupPlayer = () => {
    const nm = walkName.trim();
    if (!nm) return;
    if (setupRoster.some((r) => r.name.toLowerCase() === nm.toLowerCase())) { say("Name's taken."); return; }
    const p = { id: uid(), name: nm };
    const roster = [...setupRoster, p];
    const gs = setupGroups.map((g) => ({ ...g, players: [...g.players] }));
    const want = cfg.format === "pairs" ? 2 : cfg.teamSize;
    const short = gs.filter((g) => g.players.length < want)
      .sort((a, b) => a.players.length - b.players.length)[0];
    if (short) short.players.push(p.id);
    else gs.push({ id: uid(), name: cfg.format === "pairs" ? "Pair " + (gs.length + 1) : "Team +", players: [p.id] });
    setSetupRoster(roster); setSetupGroups(gs); setWalkName("");
  };

  const renameGroup = (gid, name) => {
    setSetupGroups(setupGroups.map((g) => (g.id === gid ? { ...g, name } : g)));
  };

  const lockStart = async () => {
    const want = cfg.format === "pairs" ? 2 : cfg.teamSize;
    const full = setupGroups.filter((g) => g.players.length >= (cfg.format === "pairs" ? 2 : 1));
    const benched = setupGroups.filter((g) => !full.includes(g));
    if (full.length < 2) { say("Need at least 2 complete " + (cfg.format === "pairs" ? "pairs." : "teams.")); return; }
    setBusy(true);
    let live = {
      ...cfg, roster: setupRoster,
      groups: setupGroups,
      inact: benched.map((g) => g.id),
      status: "live",
    };
    if (cfg.format === "teams") {
      live = { ...live, groups: full, inact: [] };
      live = genRoundRobin(live);
      if (benched.length) say("Heads up: incomplete teams were dropped.");
    }
    await sSet(kCfg(code), JSON.stringify(live));
    setCfg(live); setSetupMode(false); setTab("schedule");
    setBusy(false);
    if (cfg.format === "pairs") { say("Live! Generate round 1 from Director."); setTab("admin"); }
  };

  /* -------------------- live actions -------------------- */
  const saveScore = async (mid, a, b) => {
    const ts = Date.now();
    const key = `${kDoneP(code)}${mid}~${a}-${b}~${ts}`;
    setBusy(true);
    const ok = await sSet(key, "1");
    if (!ok) { setBusy(false); say("Couldn't save — check connection and retry."); return; }
    for (const old of resAll[mid] || []) if (old.ts < ts) sDel(old.key);
    setRes({ ...res, [mid]: { mid, a, b, ts, key } });
    setResAll({ ...resAll, [mid]: [{ mid, a, b, ts, key }] });
    setModal(null); setBusy(false);
  };

  const clearResult = async (mid) => {
    for (const old of resAll[mid] || []) await sDel(old.key);
    const r2 = { ...res }; delete r2[mid];
    const ra2 = { ...resAll }; delete ra2[mid];
    setRes(r2); setResAll(ra2); setModal(null);
    say("Result cleared.");
  };

  const nextRound = async () => {
    const out = cfg.format === "pairs" ? genPairsRound(cfg) : genMixRound(cfg);
    if (out.error) { say(out.error); return; }
    setBusy(true);
    await sSet(kCfg(code), JSON.stringify(out.cfg));
    setCfg(out.cfg); setTab("schedule"); setBusy(false);
    say(`Round ${out.cfg.rds} is up.`);
  };

  const toggleActive = async (id) => {
    const inact = (cfg.inact || []).includes(id)
      ? cfg.inact.filter((x) => x !== id)
      : [...(cfg.inact || []), id];
    const c2 = { ...cfg, inact };
    await sSet(kCfg(code), JSON.stringify(c2));
    setCfg(c2);
  };

  const addWalkupLive = async () => {
    const nm = walkName.trim();
    if (!nm) return;
    if (cfg.roster.some((r) => r.name.toLowerCase() === nm.toLowerCase())) { say("Name's taken."); return; }
    const p = { id: uid(), name: nm };
    const maxSat = Math.max(0, ...Object.values(cfg.sat || {}));
    const c2 = { ...cfg, roster: [...cfg.roster, p], sat: { ...(cfg.sat || {}), [p.id]: maxSat } };
    await sSet(kCfg(code), JSON.stringify(c2));
    setCfg(c2); setWalkName(""); say(`${nm} added — they'll rotate in next round.`);
  };

  // director adds a complete pair mid-event (rotating pairs format)
  const addWalkupPair = async () => {
    const n1 = walkName.trim(), n2 = walkName2.trim();
    if (!n1 || !n2) { say("Need both names."); return; }
    if (n1.toLowerCase() === n2.toLowerCase()) { say("Two different names."); return; }
    const taken = (n) => cfg.roster.some((r) => r.name.toLowerCase() === n.toLowerCase());
    if (taken(n1) || taken(n2)) { say("One of those names is already playing."); return; }
    const p1 = { id: uid(), name: n1 }, p2 = { id: uid(), name: n2 };
    const g = { id: uid(), name: "Pair " + ((cfg.groups || []).length + 1), players: [p1.id, p2.id] };
    const c2 = { ...cfg, roster: [...cfg.roster, p1, p2], groups: [...(cfg.groups || []), g] };
    await sSet(kCfg(code), JSON.stringify(c2));
    setCfg(c2); setWalkName(""); setWalkName2("");
    say(`${n1}/${n2} are in — they'll rotate into round ${(cfg.rds || 0) + 1}.`);
  };

  const endEvent = async () => {
    const c2 = { ...cfg, status: "done" };
    await sSet(kCfg(code), JSON.stringify(c2));
    setCfg(c2); setTab("standings"); say("Final standings are posted. 🏆");
  };
  const reopenEvent = async () => {
    const c2 = { ...cfg, status: "live" };
    await sSet(kCfg(code), JSON.stringify(c2));
    setCfg(c2); say("Scoring reopened.");
  };

  const deleteEvent = async () => {
    setBusy(true);
    for (const k of await sList(kDoneP(code))) await sDel(k);
    for (const k of await sList(kRegP(code))) await sDel(k);
    for (const k of await sList(kIdxP)) {
      const it = parseIdxKey(k);
      if (it && it.code === code) await sDel(k);
    }
    await sDel(kCfg(code));
    setBusy(false);
    say("Event deleted.");
    leave();
  };

  const pickMe = (nm) => {
    setMe(nm); sSet(kMe(code), nm, false);
  };

  /* -------------------- derived -------------------- */
  const myIds = useMemo(() => {
    if (!cfg || !me) return new Set();
    const mine = cfg.roster.filter((r) => r.name.toLowerCase() === me.toLowerCase()).map((r) => r.id);
    return new Set(mine);
  }, [cfg, me]);

  const standings = useMemo(() => (cfg && cfg.status !== "signup" ? calcStandings(cfg, res) : []), [cfg, res]);
  const doneCount = cfg ? cfg.sched.filter((m) => res[m.id]).length : 0;

  /* ==================== RENDER ==================== */

  /* ---------- landing ---------- */
  function renderLanding() {
    return (
      <Shell toast={toast}>
        <div style={{ margin: "26px 0 6px" }}><Logo /></div>
        <div style={{ color: C.dim, fontSize: 15, marginBottom: 26 }}>
          Sand &amp; grass volleyball — brackets of people, not paperwork.
        </div>
        <Card accent style={{ marginBottom: 18 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Join an event</Eyebrow>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
              placeholder="CODE"
              style={{
                flex: 1, fontFamily: MONO, fontSize: 30, fontWeight: 700, letterSpacing: "0.35em",
                textAlign: "center", padding: "10px 6px", border: `2px solid ${C.ink}`,
                borderRadius: 10, textTransform: "uppercase", width: "100%", minWidth: 0, background: "#fff", color: C.ink,
              }}
            />
            <Btn onClick={() => joinEvent(joinInput)} disabled={joinInput.length !== 4 || busy}>Join</Btn>
          </div>
        </Card>
        {recents.length > 0 && (
          <Card style={{ marginBottom: 18 }}>
            <Eyebrow style={{ marginBottom: 10 }}>Recent events</Eyebrow>
            {recents.map((r) => (
              <div key={r.key} onClick={() => joinEvent(r.code)} className="pressable"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: `1.5px dashed ${C.line}`, cursor: "pointer" }}>
                <div style={{ fontWeight: 700 }}>{r.name}</div>
                <div style={{ fontFamily: MONO, fontWeight: 700, color: C.accent }}>{r.code}</div>
              </div>
            ))}
          </Card>
        )}
        <Btn kind="ink" style={{ width: "100%" }} onClick={() => setView("create")}>+ Create a new event</Btn>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 22, lineHeight: 1.5 }}>
          Heads up: events, rosters, and scores are stored in this app's shared space — anyone using the app can see them. First names work great.
        </div>
      </Shell>
    );
  }

  /* ---------- create ---------- */
  function renderCreate() {
    return (
      <Shell toast={toast}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 20px" }}>
          <Logo small />
          <Btn kind="ghost" small onClick={leave}>✕</Btn>
        </div>
        <Card accent>
          <div style={{ fontWeight: 900, fontSize: 24, marginBottom: 14 }}>New event</div>
          <Field label="Event name" value={fName} onChange={setFName} placeholder="Saturday Grass 4s" maxLength={40} />
          <Eyebrow style={{ marginBottom: 8, color: C.ink }}>Format</Eyebrow>
          {FORMATS.map((f) => (
            <div key={f.v} onClick={() => setFFormat(f.v)} className="pressable" style={{
              border: `2px solid ${C.ink}`, borderRadius: 12, padding: "12px 14px", marginBottom: 10,
              background: fFormat === f.v ? C.ink : "#fff", color: fFormat === f.v ? C.paper : C.ink,
              cursor: "pointer", boxShadow: `2px 2px 0 ${C.ink}`,
            }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{f.label}</div>
              <div style={{ fontSize: 13.5, opacity: 0.85, marginTop: 2 }}>{f.desc}</div>
            </div>
          ))}
          {fFormat !== "pairs" && (
            <Stepper label={fFormat === "mix" ? "Players per side" : "Players per team"} value={fTeamSize} onChange={setFTeamSize} min={2} max={6} />
          )}
          <Stepper label="Courts" value={fCourts} onChange={setFCourts} min={1} max={8} />
          <Eyebrow style={{ margin: "4px 0 8px", color: C.ink }}>Game to</Eyebrow>
          <div style={{ marginBottom: 16 }}>
            <ChoiceRow value={fPoints} onChange={setFPoints}
              options={[{ v: 11, label: "11" }, { v: 15, label: "15" }, { v: 21, label: "21" }, { v: 25, label: "25" }]} />
          </div>
          <Field label="Director PIN (4 digits)" value={fPin} inputMode="numeric"
            onChange={(v) => setFPin(v.replace(/\D/g, "").slice(0, 4))}
            placeholder="••••" hint="Unlocks director controls on any phone." />
          <Btn style={{ width: "100%" }} disabled={busy} onClick={createEvent}>Create event</Btn>
        </Card>
      </Shell>
    );
  }

  /* ---------- event header ---------- */
  function renderHeader() {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 21, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cfg.name}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3 }}>
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, color: C.accent }}>{code}</span>
            <span style={{ fontSize: 12, color: C.dim }}>
              {cfg.status === "signup" ? "signup open" : cfg.status === "done" ? "final" : `live · ${doneCount}/${cfg.sched.length} scored`}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <Btn kind="ghost" small onClick={() => refresh(true)}>{busy ? "…" : "↻"}</Btn>
          <Btn kind="ghost" small onClick={leave}>✕</Btn>
        </div>
      </div>
    );
  }

  /* ---------- lobby (signup) ---------- */
  function renderLobby() {
    return (
      <Shell toast={toast}>
        {renderHeader()}
        <Card accent style={{ textAlign: "center", marginBottom: 16 }}>
          <Eyebrow>Join code</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 64, fontWeight: 700, letterSpacing: "0.18em", margin: "2px 0 4px" }}>{code}</div>
          <div style={{ fontSize: 14, color: C.dim }}>Players: open this same app, punch in the code, add your name.</div>
        </Card>
        <Card style={{ marginBottom: 16 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Sign yourself up</Eyebrow>
          <Field label="Your name" value={regName} onChange={setRegName} placeholder="First name + initial" maxLength={20} />
          {cfg.format === "pairs" && (
            <Field label="Partner (optional)" value={regExtra} onChange={setRegExtra} placeholder="Their name as they signed up" maxLength={20} hint="If you both list each other, you're locked in." />
          )}
          {cfg.format === "teams" && (
            <Field label="Team name (optional)" value={regExtra} onChange={setRegExtra} placeholder="e.g. Net Gains" maxLength={20} hint="Everyone using the same team name lands together." />
          )}
          <Btn style={{ width: "100%" }} disabled={busy} onClick={register}>I'm in 🏐</Btn>
        </Card>
        <Card style={{ marginBottom: 16 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Roster · {regs.length}</Eyebrow>
          {regs.length === 0 && <div style={{ color: C.dim, fontSize: 14.5 }}>Nobody yet — be the first one in.</div>}
          {regs.map((r) => (
            <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 2px", borderBottom: `1.5px dashed ${C.line}` }}>
              <div>
                <span style={{ fontWeight: 700 }}>{r.name}</span>
                {r.extra && <span style={{ color: C.dim, fontSize: 13 }}> · {cfg.format === "pairs" ? "w/ " : ""}{r.extra}</span>}
              </div>
              {adminOk && <button onClick={() => removeReg(r)} style={{ border: "none", background: "none", color: "#B3261E", fontWeight: 800, fontSize: 16, cursor: "pointer" }}>✕</button>}
            </div>
          ))}
        </Card>
        <Card style={{ background: "#FBF3E4" }}>
          <Eyebrow style={{ marginBottom: 8 }}>Director</Eyebrow>
          {!adminOk ? (
            <div style={{ display: "flex", gap: 10 }}>
              <input value={pinInput} inputMode="numeric" onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="PIN"
                style={{ flex: 1, fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: "0.3em", textAlign: "center", padding: "8px", border: `2px solid ${C.ink}`, borderRadius: 10, minWidth: 0, background: "#fff", color: C.ink }} />
              <Btn small onClick={unlockAdmin}>Unlock</Btn>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 14, color: C.dim, marginBottom: 10 }}>
                {cfg.format === "mix"
                  ? "Start when everyone's here — teams shuffle every round."
                  : cfg.format === "pairs"
                    ? "Starting builds pairs from partner requests; you can edit before locking."
                    : "Starting builds teams from team names; you can edit before locking."}
              </div>
              <Eyebrow style={{ margin: "2px 0 6px" }}>Add a player — no phone needed</Eyebrow>
              <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Name"
                style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
              {cfg.format !== "mix" && (
                <input value={walkExtra} onChange={(e) => setWalkExtra(e.target.value)}
                  placeholder={cfg.format === "pairs" ? "Partner (optional)" : "Team name (optional)"}
                  style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
              )}
              <Btn kind="ink" small style={{ width: "100%", marginBottom: 14 }} onClick={directorAdd}>Add to roster</Btn>
              <Btn kind="green" style={{ width: "100%" }} disabled={regs.length < 4 || busy} onClick={startSetup}>
                {cfg.format === "mix" ? "Start event" : "Build " + (cfg.format === "pairs" ? "pairs" : "teams") + " →"}
              </Btn>
            </div>
          )}
        </Card>
      </Shell>
    );
  }

  /* ---------- setup editor ---------- */
  function renderSetup() {
    const want = cfg.format === "pairs" ? 2 : cfg.teamSize;
    return (
      <Shell toast={toast}>
        {renderHeader()}
        <Card accent style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 20 }}>{cfg.format === "pairs" ? "Set the pairs" : "Set the teams"}</div>
          <div style={{ fontSize: 13.5, color: C.dim, marginTop: 4 }}>
            Tap one player, then another, to swap them. {cfg.format === "teams" ? "Tap a team name to rename it." : ""}
          </div>
        </Card>
        {setupGroups.map((g) => (
          <Card key={g.id} style={{ marginBottom: 12, padding: 12, borderLeft: g.players.length < want ? `6px solid ${C.gold}` : `2px solid ${C.ink}` }}>
            {cfg.format === "teams" ? (
              <input value={g.name} onChange={(e) => renameGroup(g.id, e.target.value)}
                style={{ fontWeight: 800, fontSize: 16, border: "none", background: "transparent", color: C.ink, width: "100%", marginBottom: 6, padding: 0 }} />
            ) : (
              <Eyebrow style={{ marginBottom: 6 }}>{g.name}{g.players.length < 2 ? " · needs a partner" : ""}</Eyebrow>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {g.players.map((pid) => {
                const p = setupRoster.find((r) => r.id === pid);
                return (
                  <button key={pid} className="pressable" onClick={() => tapChip(pid)} style={{
                    padding: "9px 13px", borderRadius: 999, fontWeight: 700, fontSize: 15,
                    border: `2px solid ${C.ink}`,
                    background: sel === pid ? C.accent : "#fff",
                    color: sel === pid ? "#fff" : C.ink,
                    boxShadow: `2px 2px 0 ${C.ink}`,
                  }}>{p ? p.name : "?"}</button>
                );
              })}
            </div>
          </Card>
        ))}
        <Card style={{ marginBottom: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Add a walk-up</Eyebrow>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Name"
              style={{ flex: 1, padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, minWidth: 0, background: "#fff", color: C.ink }} />
            <Btn small onClick={addSetupPlayer}>Add</Btn>
          </div>
        </Card>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn kind="ghost" style={{ flex: 1 }} onClick={reshuffleSetup}>Reshuffle</Btn>
          <Btn kind="green" style={{ flex: 2 }} disabled={busy} onClick={lockStart}>Lock &amp; start ✓</Btn>
        </div>
        <div style={{ marginTop: 12 }}>
          <Btn kind="ghost" small onClick={() => setSetupMode(false)}>← Back to signup</Btn>
        </div>
      </Shell>
    );
  }

  /* ---------- live: schedule ---------- */
  function renderSchedule() {
    if (cfg.sched.length === 0) {
      return (
        <Card style={{ textAlign: "center", padding: 28 }}>
          <div style={{ fontSize: 40 }}>🏐</div>
          <div style={{ fontWeight: 800, fontSize: 18, marginTop: 6 }}>No rounds yet</div>
          <div style={{ color: C.dim, fontSize: 14.5, marginTop: 4 }}>
            {adminOk ? "Generate round 1 from the Director tab." : "The director hasn't posted round 1 yet."}
          </div>
        </Card>
      );
    }
    const rounds = [...new Set(cfg.sched.map((m) => m.rd))].sort((a, b) => b - a);
    return (
      <div>
        {rounds.map((rd) => {
          const ms = cfg.sched.filter((m) => m.rd === rd);
          const byes = (cfg.byes || {})[rd] || [];
          const sit = (cfg.sit || {})[rd] || [];
          return (
            <div key={rd} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, background: C.accent, color: "#fff", borderRadius: 8, padding: "4px 10px" }}>ROUND {rd}</div>
                <div style={{ flex: 1, borderTop: `2px solid ${C.line}` }} />
              </div>
              {ms.map((m) => (
                <MatchCard key={m.id} cfg={cfg} match={m} result={res[m.id]} highlightIds={myIds}
                  onTap={() => cfg.status === "done" && !adminOk ? say("Event is final — director can reopen scoring.") : setModal(m)} />
              ))}
              {byes.length > 0 && (
                <div style={{ fontSize: 13.5, color: C.dim, marginTop: -4 }}>
                  Bye: {byes.map((g) => groupLabel(cfg, g)).join(", ")}
                </div>
              )}
              {sit.length > 0 && (
                <div style={{ fontSize: 13.5, color: C.dim, marginTop: -4 }}>
                  Sitting: {sit.map((p) => nameOf(cfg, p)).join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  /* ---------- live: standings ---------- */
  function renderStandings() {
    const fmtLabel = cfg.format === "mix" ? "Player" : cfg.format === "pairs" ? "Pair" : "Team";
    return (
      <div>
        {cfg.status === "done" && (
          <Card accent style={{ textAlign: "center", marginBottom: 14, background: C.greenSoft }}>
            <div style={{ fontWeight: 900, fontSize: 20 }}>🏆 Final standings</div>
          </Card>
        )}
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", padding: "10px 14px", background: C.ink, color: C.paper, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em" }}>
            <div style={{ width: 34 }}>#</div>
            <div style={{ flex: 1 }}>{fmtLabel.toUpperCase()}</div>
            <div style={{ width: 56, textAlign: "right" }}>W–L</div>
            <div style={{ width: 56, textAlign: "right" }}>DIFF</div>
          </div>
          {standings.map((s, i) => {
            const diff = s.pf - s.pa;
            return (
              <div key={s.id} style={{
                display: "flex", alignItems: "center", padding: "11px 14px",
                borderBottom: `1.5px dashed ${C.line}`,
                background: i === 0 && s.gp > 0 ? "#FFF8E6" : "#fff",
              }}>
                <div style={{ width: 34, fontFamily: MONO, fontWeight: 700, color: i === 0 && s.gp > 0 ? C.gold : C.dim }}>{i + 1}</div>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 15.5, paddingRight: 6 }}>{s.label}</div>
                <div style={{ width: 56, textAlign: "right", fontFamily: MONO, fontWeight: 700 }}>{s.w}–{s.l}</div>
                <div style={{ width: 56, textAlign: "right", fontFamily: MONO, color: diff > 0 ? C.green : diff < 0 ? "#B3261E" : C.dim }}>
                  {diff > 0 ? "+" : ""}{diff}
                </div>
              </div>
            );
          })}
        </Card>
        <div style={{ fontSize: 12.5, color: C.dim, marginTop: 10 }}>Ranked by wins, then point differential, then points for.</div>
      </div>
    );
  }

  /* ---------- live: me ---------- */
  function renderMe() {
    if (!me || myIds.size === 0) {
      const names = cfg.roster.map((r) => r.name).filter((n) => n.toLowerCase().includes(meFilter.toLowerCase()));
      return (
        <Card>
          <Eyebrow style={{ marginBottom: 8 }}>Who are you?</Eyebrow>
          <input value={meFilter} onChange={(e) => setMeFilter(e.target.value)} placeholder="Find your name…"
            style={{ width: "100%", boxSizing: "border-box", padding: "11px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 12, background: "#fff", color: C.ink }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {names.map((n) => (
              <button key={n} className="pressable" onClick={() => pickMe(n)} style={{ padding: "9px 13px", borderRadius: 999, fontWeight: 700, fontSize: 15, border: `2px solid ${C.ink}`, background: "#fff", boxShadow: `2px 2px 0 ${C.ink}`, color: C.ink }}>{n}</button>
            ))}
          </div>
        </Card>
      );
    }
    const mine = cfg.sched.filter((m) =>
      sidePlayerIds(cfg, m.a).some((x) => myIds.has(x)) || sidePlayerIds(cfg, m.b).some((x) => myIds.has(x)));
    const pending = mine.filter((m) => !res[m.id]);
    const played = mine.filter((m) => res[m.id]).reverse();
    let w = 0, l = 0, diff = 0;
    for (const m of played) {
      const r = res[m.id];
      const onA = sidePlayerIds(cfg, m.a).some((x) => myIds.has(x));
      const my = onA ? r.a : r.b, their = onA ? r.b : r.a;
      my > their ? w++ : l++; diff += my - their;
    }
    return (
      <div>
        <Card accent style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <Eyebrow>Playing as</Eyebrow>
            <div style={{ fontWeight: 900, fontSize: 22 }}>{me}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 24 }}>{w}–{l}</div>
            <div style={{ fontFamily: MONO, fontSize: 13, color: diff >= 0 ? C.green : "#B3261E" }}>{diff >= 0 ? "+" : ""}{diff}</div>
          </div>
        </Card>
        <button onClick={() => { setMe(""); sDel(kMe(code), false); }} style={{ border: "none", background: "none", color: C.dim, fontSize: 13, textDecoration: "underline", marginBottom: 12, cursor: "pointer", padding: 0 }}>Not you? Switch player</button>
        <Eyebrow style={{ margin: "4px 0 10px" }}>Up next</Eyebrow>
        {pending.length === 0 && <div style={{ color: C.dim, fontSize: 14.5, marginBottom: 14 }}>Nothing on the board — hydrate. 🧃</div>}
        {pending.map((m) => <MatchCard key={m.id} cfg={cfg} match={m} result={null} highlightIds={myIds} onTap={() => setModal(m)} />)}
        {played.length > 0 && <Eyebrow style={{ margin: "10px 0" }}>Played</Eyebrow>}
        {played.map((m) => <MatchCard key={m.id} cfg={cfg} match={m} result={res[m.id]} highlightIds={myIds} onTap={() => setModal(m)} />)}
      </div>
    );
  }

  /* ---------- live: director ---------- */
  function renderAdmin() {
    if (!adminOk) {
      return (
        <Card>
          <Eyebrow style={{ marginBottom: 8 }}>Director PIN</Eyebrow>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={pinInput} inputMode="numeric" onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              style={{ flex: 1, fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: "0.3em", textAlign: "center", padding: "8px", border: `2px solid ${C.ink}`, borderRadius: 10, minWidth: 0, background: "#fff", color: C.ink }} />
            <Btn small onClick={unlockAdmin}>Unlock</Btn>
          </div>
        </Card>
      );
    }
    const isRoundBased = cfg.format !== "teams";
    const actList = cfg.format === "mix"
      ? cfg.roster.map((r) => ({ id: r.id, label: r.name, meta: `sat ${(cfg.sat || {})[r.id] || 0}` }))
      : cfg.format === "pairs"
        ? (cfg.groups || []).map((g) => ({ id: g.id, label: groupLabel(cfg, g.id), meta: "" }))
        : [];
    return (
      <div>
        {isRoundBased && cfg.status === "live" && (
          <Card accent style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Rounds</Eyebrow>
            <Btn kind="green" style={{ width: "100%" }} disabled={busy} onClick={nextRound}>
              Generate round {(cfg.rds || 0) + 1} →
            </Btn>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
              {cfg.format === "pairs"
                ? "Pairs are combined into fresh 4s, spreading out repeat partners and byes."
                : "Teams reshuffle for variety; whoever sat last round plays first."}
            </div>
          </Card>
        )}
        {actList.length > 0 && (
          <Card style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Who's in for the next round</Eyebrow>
            {actList.map((a) => {
              const off = (cfg.inact || []).includes(a.id);
              return (
                <div key={a.id} onClick={() => toggleActive(a.id)} className="pressable" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 2px", borderBottom: `1.5px dashed ${C.line}`, cursor: "pointer" }}>
                  <div style={{ fontWeight: 700, color: off ? C.dim : C.ink, textDecoration: off ? "line-through" : "none" }}>{a.label}</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    {a.meta && <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>{a.meta}</span>}
                    <span style={{ fontWeight: 800, fontSize: 13, color: off ? C.dim : C.green }}>{off ? "OUT" : "IN"}</span>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
        {cfg.format === "mix" && cfg.status === "live" && (
          <Card style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Walk-up player</Eyebrow>
            <div style={{ display: "flex", gap: 10 }}>
              <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Name"
                style={{ flex: 1, padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, minWidth: 0, background: "#fff", color: C.ink }} />
              <Btn small onClick={addWalkupLive}>Add</Btn>
            </div>
          </Card>
        )}
        {cfg.format === "pairs" && cfg.status === "live" && (
          <Card style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Walk-up pair — no phones needed</Eyebrow>
            <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Player 1"
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
            <input value={walkName2} onChange={(e) => setWalkName2(e.target.value)} placeholder="Player 2"
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
            <Btn small style={{ width: "100%" }} onClick={addWalkupPair}>Add pair</Btn>
          </Card>
        )}
        <Card style={{ marginBottom: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Fix a score</Eyebrow>
          <div style={{ fontSize: 14, color: C.dim }}>Tap any match on the Schedule tab — directors can update or clear results.</div>
        </Card>
        <Card style={{ background: "#FBF3E4" }}>
          <Eyebrow style={{ marginBottom: 10 }}>Event controls</Eyebrow>
          {cfg.status === "live"
            ? <Btn kind="ink" style={{ width: "100%", marginBottom: 10 }} onClick={endEvent}>End event &amp; post final standings 🏆</Btn>
            : <Btn kind="ink" style={{ width: "100%", marginBottom: 10 }} onClick={reopenEvent}>Reopen scoring</Btn>}
          {!confirmDel
            ? <Btn kind="danger" style={{ width: "100%" }} onClick={() => setConfirmDel(true)}>Delete event…</Btn>
            : <div style={{ display: "flex", gap: 10 }}>
                <Btn kind="ghost" style={{ flex: 1 }} onClick={() => setConfirmDel(false)}>Keep it</Btn>
                <Btn kind="danger" style={{ flex: 1 }} disabled={busy} onClick={deleteEvent}>Really delete</Btn>
              </div>}
        </Card>
      </div>
    );
  }

  /* ---------- live shell with tabs ---------- */
  function renderEvent() {
    if (cfg.status === "signup" && setupMode) return renderSetup();
    if (cfg.status === "signup") return renderLobby();
    const TABS = [
      { v: "schedule", label: "Schedule", ico: "🗓" },
      { v: "standings", label: "Standings", ico: "🏆" },
      { v: "me", label: "Me", ico: "🏐" },
      { v: "admin", label: "Director", ico: adminOk ? "🎛" : "🔒" },
    ];
    return (
      <Shell toast={toast}>
        {renderHeader()}
        {tab === "schedule" && renderSchedule()}
        {tab === "standings" && renderStandings()}
        {tab === "me" && renderMe()}
        {tab === "admin" && renderAdmin()}
        {lastSync && (
          <div style={{ fontSize: 11.5, color: C.dim, textAlign: "center", marginTop: 16 }}>
            Synced {lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · auto-refreshes every 20s
          </div>
        )}
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, background: C.paper,
          borderTop: `3px solid ${C.ink}`, display: "flex", justifyContent: "center", zIndex: 40,
        }}>
          <div style={{ display: "flex", width: "100%", maxWidth: 600 }}>
            {TABS.map((t) => (
              <button key={t.v} onClick={() => setTab(t.v)} style={{
                flex: 1, border: "none", background: tab === t.v ? C.ink : "transparent",
                color: tab === t.v ? C.paper : C.ink, padding: "10px 0 12px",
                fontWeight: 800, fontSize: 11.5, letterSpacing: "0.04em", cursor: "pointer",
              }}>
                <div style={{ fontSize: 18 }}>{t.ico}</div>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {modal && (
          <ScoreModal cfg={cfg} match={modal} existing={res[modal.id]}
            canClear={adminOk}
            onSave={(a, b) => saveScore(modal.id, a, b)}
            onClear={() => clearResult(modal.id)}
            onClose={() => setModal(null)} />
        )}
      </Shell>
    );
  }

  if (view === "create") return renderCreate();
  if (view === "event" && cfg) return renderEvent();
  return renderLanding();
}
