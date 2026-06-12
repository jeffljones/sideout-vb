/* =====================================================================
   SIDEOUT engine — scheduling, grouping, standings.
   Pure logic, no I/O. Ported unchanged from the original artifact
   (sideout.jsx); covered by engine.test.js.

   cfg = { v, code, name, format: 'teams'|'pairs'|'mix', teamSize,
           courts, pointsTo, pin, status: 'signup'|'live'|'done',
           created, roster:[{id,name}], groups:[{id,name,players:[pid]}]|null,
           sched:[{id, rd, ct, a, b}], rds, mseq,
           byes:{rd:[groupId|pid,...]}, sit:{rd:[pid,...]},
           inact:[ids], sat:{pid:n} }
   side = {g:[groupId,...]} for teams/pairs, {p:[pid,...]} for mix
   ===================================================================== */

export const uid = () => Math.random().toString(36).slice(2, 8);

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ";
export const newCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

export const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
export const pk = (x, y) => (x < y ? x + "|" + y : y + "|" + x);

/* ---------------------- side/label helpers ---------------------- */
export const nameOf = (cfg, pid) => (cfg.roster.find((r) => r.id === pid) || {}).name || "?";
export const groupOf = (cfg, gid) => (cfg.groups || []).find((g) => g.id === gid);
export function groupLabel(cfg, gid) {
  const g = groupOf(cfg, gid);
  if (!g) return "?";
  if (cfg.format === "pairs") return g.players.map((p) => nameOf(cfg, p)).join("/") || g.name;
  return g.name;
}
export function sideLabel(cfg, side) {
  if (side.p) return side.p.map((p) => nameOf(cfg, p)).join(" · ");
  return side.g.map((gid) => groupLabel(cfg, gid)).join("  +  ");
}
export function sideStatIds(cfg, side) {
  return side.p ? side.p : side.g;
}
export function sidePlayerIds(cfg, side) {
  if (side.p) return side.p;
  return side.g.flatMap((gid) => (groupOf(cfg, gid) || { players: [] }).players);
}

/* ---------------------- history (variety) ---------------------- */
export function buildHist(cfg) {
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
export function genRoundRobin(cfg) {
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
export function genPairsRound(cfg) {
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
export function genMixRound(cfg) {
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
export function calcStandings(cfg, res) {
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
export function buildPairs(roster, regs) {
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

export function buildTeams(roster, regs, teamSize) {
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
