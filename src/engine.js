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
  // optional 1–3 skill ratings; unrated players count as middle. When
  // nobody is rated the original variety-only behavior is untouched.
  const skillOf = new Map(cfg.roster.map((r) => [r.id, r.skill || 2]));
  const skillsVary = new Set(active.map((pid) => skillOf.get(pid))).size > 1;
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
    const sum = (team) => team.reduce((acc, q) => acc + skillOf.get(q), 0);
    for (const p of pool) {
      const costTo = (team) => team.reduce((acc, q) => acc + (tm.get(pk(p, q)) || 0), 0);
      if (A.length >= size) B.push(p);
      else if (B.length >= size) A.push(p);
      else if (skillsVary) {
        // balance first, repeat-teammate history breaks ties
        const ca = Math.abs(sum(A) + skillOf.get(p) - sum(B)) * 4 + costTo(A);
        const cb = Math.abs(sum(B) + skillOf.get(p) - sum(A)) * 4 + costTo(B);
        if (ca < cb) A.push(p);
        else if (cb < ca) B.push(p);
        else (A.length <= B.length ? A : B).push(p);
      } else {
        const ca = costTo(A), cb = costTo(B);
        if (ca < cb) A.push(p);
        else if (cb < ca) B.push(p);
        else (A.length <= B.length ? A : B).push(p);
      }
    }
    if (skillsVary) {
      // local swap pass: tighten the skill gap while it improves
      let improved = true;
      while (improved) {
        improved = false;
        const d0 = Math.abs(sum(A) - sum(B));
        let best = null, bestDiff = d0;
        for (let i = 0; i < A.length; i++) {
          for (let j = 0; j < B.length; j++) {
            const delta = skillOf.get(B[j]) - skillOf.get(A[i]);
            const nd = Math.abs(sum(A) - sum(B) + 2 * delta);
            if (nd < bestDiff) { bestDiff = nd; best = [i, j]; }
          }
        }
        if (best) {
          const [i, j] = best;
          [A[i], B[j]] = [B[j], A[i]];
          improved = true;
        }
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
// Team events: one registration IS one team — { name: team name,
// extra: optional comma-separated player first names, lvl }. Returns
// { roster, groups } with groups 1:1 to regs. Solos/orphans are handled
// offline by the director (proxy-add the assembled team).
export function buildTeamsFromRegs(regs) {
  const roster = [];
  const groups = regs.map((reg) => {
    const players = (reg.extra || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((n) => {
        const p = { id: uid(), name: n };
        roster.push(p);
        return p.id;
      });
    return { id: uid(), name: reg.name, players, ...(reg.lvl ? { lvl: reg.lvl } : {}) };
  });
  return { roster, groups };
}

// Pairs events: one registration IS one pair — { name: player 1,
// extra: player 2 }. Returns { roster, groups } with groups 1:1 to regs.
export function buildPairsFromRegs(regs) {
  const roster = [];
  const groups = regs.map((reg, i) => {
    const players = [reg.name, reg.extra]
      .map((s) => (s || "").trim()).filter(Boolean)
      .map((n) => {
        const p = { id: uid(), name: n };
        roster.push(p);
        return p.id;
      });
    return { id: uid(), name: "Pair " + (i + 1), players };
  });
  return { roster, groups };
}

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
  const lvlOf = new Map(); // pid -> requested level
  for (const reg of regs) {
    const pid = byName.get(reg.name.toLowerCase());
    if (pid && reg.lvl) lvlOf.set(pid, reg.lvl);
    if (!pid || !reg.extra) continue;
    const key = reg.extra.toLowerCase();
    if (!named.has(key)) named.set(key, { label: reg.extra, players: [] });
    if (named.get(key).players.length < teamSize) {
      named.get(key).players.push(pid);
      claimed.add(pid);
    }
  }
  // a team's level: first member with a stated one
  const teamLvl = (players) => {
    for (const pid of players) if (lvlOf.has(pid)) return lvlOf.get(pid);
    return "";
  };
  const groups = [...named.values()].map((t) => {
    const lvl = teamLvl(t.players);
    return { id: uid(), name: t.label, players: t.players, ...(lvl ? { lvl } : {}) };
  });
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
      const lvl = teamLvl(chunk);
      groups.push({ id: uid(), name: "Team " + letters[li++ % 26], players: chunk, ...(lvl ? { lvl } : {}) });
    }
  }
  return groups;
}

/* =====================================================================
   Pool play + double-elimination playoffs (fixed-team tournaments)

   Tournament day shape: teams (optionally split into two pools) play a
   round robin, then seed into a double-elim bracket. Winners-bracket
   matches and the grand final are best-of-3; the losers bracket and the
   deciding game are single games. If the losers-bracket team wins the
   grand final, a single deciding game is *available* — generating it is
   the director's call (teams sometimes agree to let the Bo3 stand).

   cfg additions: stage ''|'pool'|'playoff', pools 1|2, poolGames 1|2,
   seeds [gid...] (bracket seed order), po {g12, g3} (game targets).
   groups gain .pool (1|2). Bracket sched entries carry
   { br:'w'|'l'|'gf'|'gf2', brd, bo, lbl } and use deterministic ids
   ('w1s2', 'l3s1', 'gf', 'gf2'); each game stores its own result doc
   under id + 'g1'..'g3', so the results schema is unchanged.
   ===================================================================== */

// circle-method round robin for one pool → [{pairs:[[x,y],...], bye}, ...]
function circleRounds(ids) {
  const arr = [...ids];
  if (arr.length < 2) return [];
  if (arr.length % 2) arr.push(null);
  const n = arr.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    let bye = null;
    for (let i = 0; i < n / 2; i++) {
      const x = arr[i], y = arr[n - 1 - i];
      if (x === null || y === null) { bye = x === null ? y : x; continue; }
      pairs.push([x, y]);
    }
    rounds.push({ pairs, bye });
    arr.splice(1, 0, arr.pop());
  }
  return rounds;
}

// Round robin within each pool (1..6 pools), merged round-by-round.
// poolGames=2 emits each matchup twice, back to back on the same court
// (sharing one ref). Every match gets a ref from its own pool: the bye
// team when there is one, otherwise a team from the round's other matchup
// — on a single net the other matchup is waiting courtside anyway. Duty
// balances over the day. Best-effort: 2-team pools have no ref.
export function genPoolPlay(cfg) {
  const nPools = Math.max(1, cfg.pools || 1);
  const games = cfg.poolGames === 2 ? 2 : 1;
  const byPool = Array.from({ length: nPools }, () => []);
  for (const g of cfg.groups) {
    const p = Math.min(nPools, Math.max(1, g.pool || 1));
    byPool[p - 1].push(g.id);
  }
  const roundLists = byPool.map((ids) => circleRounds(ids));
  const rds = Math.max(...roundLists.map((r) => r.length), 0);
  const sched = [];
  const byes = {};
  const refCount = {};
  let seq = cfg.mseq || 0;
  for (let r = 0; r < rds; r++) {
    const rd = r + 1;
    let courtIdx = 0;
    roundLists.forEach((rounds, pi) => {
      const round = rounds[r];
      if (!round) return;
      if (round.bye) byes[rd] = [...(byes[rd] || []), round.bye];
      const usedThisRd = new Set();
      for (const [x, y] of round.pairs) {
        const ct = (courtIdx++ % cfg.courts) + 1;
        const cands = byPool[pi]
          .filter((t) => t !== x && t !== y && !usedThisRd.has(t))
          .sort((a, b) =>
            (b === round.bye) - (a === round.bye) ||
            (refCount[a] || 0) - (refCount[b] || 0));
        const ref = cands[0];
        if (ref) { usedThisRd.add(ref); refCount[ref] = (refCount[ref] || 0) + 1; }
        for (let gI = 0; gI < games; gI++) {
          sched.push({
            id: "m" + ++seq, rd, ct,
            a: { g: [x] }, b: { g: [y] },
            ...(nPools > 1 ? { pl: pi + 1 } : {}),
            ...(ref ? { ref } : {}),
          });
        }
      }
    });
  }
  return { ...cfg, sched, byes, rds, mseq: seq };
}

/* ---------------------- series (multi-game matches) ---------------------- */
export function matchGames(m, res) {
  if (!m.br) { const r = res[m.id]; return r ? [r] : []; }
  const out = [];
  for (let g = 1; g <= (m.bo || 1); g++) {
    const r = res[m.id + "g" + g];
    if (r) out.push(r);
  }
  return out;
}
export function seriesScore(m, res) {
  const games = matchGames(m, res);
  let aW = 0, bW = 0;
  for (const g of games) g.a > g.b ? aW++ : bW++;
  const need = Math.floor((m.bo || 1) / 2) + 1;
  return { games, aW, bW, need, done: aW >= need || bW >= need };
}
export function matchDone(m, res) {
  if (!m.br) return !!res[m.id];
  return seriesScore(m, res).done;
}
// target points for game gi (0-based) of a match
export function getGameTarget(cfg, m, gi) {
  if (!m.br) return cfg.pointsTo;
  const po = cfg.po || {};
  const g12 = po.g12 || 21, g3 = po.g3 || 15;
  if (m.br === "l") return g12;     // losers bracket: single game
  if (m.br === "gf2") return g3;    // deciding game
  return gi === 2 ? g3 : g12;       // Bo3: G1/G2 long, G3 short
}

/* ---------------------- bracket structure ---------------------- */
// An event can run several playoff brackets (divisions). Each bracket is
// { pfx, name, seeds }: pfx prefixes every match id ('b2w1s1', 'b2gf'),
// name is the display letter, seeds is the team order. Legacy
// single-bracket events normalize to one bracket with pfx ''.

// All potential matches for one seeded double-elim bracket, in dependency
// order. Sides reference seeds or winners/losers of earlier matches.
export function buildBracket(seedIds, pfx = "") {
  const N = seedIds.length;
  const P = N <= 2 ? 2 : 2 ** Math.ceil(Math.log2(N));
  const R = Math.log2(P);
  // standard seeded first-round order, e.g. P=8 → 1,8,4,5,2,7,3,6
  let ord = [1];
  while (ord.length < P) {
    const m = ord.length * 2 + 1;
    ord = ord.map((x) => [x, m - x]).flat();
  }
  const seedAt = (pos) => (pos <= N ? seedIds[pos - 1] : null);
  const specs = [];
  for (let s = 1; s <= P / 2; s++)
    specs.push({
      id: `${pfx}w1s${s}`, br: "w", brd: 1, bo: 3,
      a: { seed: seedAt(ord[2 * s - 2]) }, b: { seed: seedAt(ord[2 * s - 1]) },
    });
  for (let r = 2; r <= R; r++)
    for (let s = 1; s <= P / 2 ** r; s++)
      specs.push({
        id: `${pfx}w${r}s${s}`, br: "w", brd: r, bo: 3,
        a: { w: `${pfx}w${r - 1}s${2 * s - 1}` }, b: { w: `${pfx}w${r - 1}s${2 * s}` },
      });
  if (R >= 2) {
    for (let s = 1; s <= P / 4; s++)
      specs.push({
        id: `${pfx}l1s${s}`, br: "l", brd: 1, bo: 1,
        a: { l: `${pfx}w1s${2 * s - 1}` }, b: { l: `${pfx}w1s${2 * s}` },
      });
    for (let r = 2; r <= 2 * R - 2; r++) {
      const n = P / 2 ** (Math.ceil(r / 2) + 1);
      for (let s = 1; s <= n; s++) {
        if (r % 2 === 0) {
          // drop round: LB survivors meet WB round-k losers; reverse the
          // drop order on alternating rounds to push rematches later
          const k = r / 2 + 1;
          const drop = k % 2 === 0 ? n - s + 1 : s;
          specs.push({
            id: `${pfx}l${r}s${s}`, br: "l", brd: r, bo: 1,
            a: { w: `${pfx}l${r - 1}s${s}` }, b: { l: `${pfx}w${k}s${drop}` },
          });
        } else {
          specs.push({
            id: `${pfx}l${r}s${s}`, br: "l", brd: r, bo: 1,
            a: { w: `${pfx}l${r - 1}s${2 * s - 1}` }, b: { w: `${pfx}l${r - 1}s${2 * s}` },
          });
        }
      }
    }
  }
  specs.push({
    id: `${pfx}gf`, br: "gf", brd: 1, bo: 3,
    a: { w: `${pfx}w${R}s1` },
    b: R >= 2 ? { w: `${pfx}l${2 * R - 2}s1` } : { l: `${pfx}w1s1` },
  });
  specs.push({ id: `${pfx}gf2`, br: "gf2", brd: 1, bo: 1, a: { w: `${pfx}gf` }, b: { l: `${pfx}gf` } });
  return specs;
}

export function bracketLabel(sp, R, name = "") {
  const tag = name ? `${name} · ` : "";
  if (sp.br === "w") return tag + (sp.brd === R ? "WINNERS FINAL" : `WINNERS R${sp.brd}`);
  if (sp.br === "l") return tag + (sp.brd === 2 * R - 2 ? "LOSERS FINAL" : `LOSERS R${sp.brd}`);
  if (sp.br === "gf2") return tag + "DECIDING GAME";
  return tag + "GRAND FINAL";
}

// The brackets list, with legacy single-bracket events normalized.
export function eventBrackets(cfg) {
  if (cfg.brackets && cfg.brackets.length) return cfg.brackets;
  if (cfg.seeds && cfg.seeds.length) return [{ pfx: "", name: "", seeds: cfg.seeds }];
  return [];
}

// Resolves every slot of one bracket from seeds + results. Sides are a
// team id, null (bye), or undefined (not yet determined). status:
// 'pending' | 'bye' (auto-advance) | 'ready' | 'done'.
export function resolveBracket(cfg, res, bracket) {
  const specs = buildBracket(bracket.seeds || [], bracket.pfx || "");
  const state = new Map();
  const side = (src) => {
    if ("seed" in src) return src.seed;
    const ref = state.get(src.w || src.l);
    if (!ref) return undefined;
    return "w" in src ? ref.winner : ref.loser;
  };
  for (const sp of specs) {
    const aId = side(sp.a), bId = side(sp.b);
    const st = { spec: sp, aId, bId, status: "pending", winner: undefined, loser: undefined };
    if (aId !== undefined && bId !== undefined) {
      if (aId === null && bId === null) {
        st.status = "bye"; st.winner = null; st.loser = null;
      } else if (aId === null || bId === null) {
        st.status = "bye"; st.winner = aId || bId; st.loser = null;
      } else {
        const ser = seriesScore({ id: sp.id, br: sp.br, bo: sp.bo }, res);
        if (ser.done) {
          st.status = "done";
          st.winner = ser.aW > ser.bW ? aId : bId;
          st.loser = ser.aW > ser.bW ? bId : aId;
        } else st.status = "ready";
      }
    }
    state.set(sp.id, st);
  }
  const N = (bracket.seeds || []).length;
  const R = Math.log2(N <= 2 ? 2 : 2 ** Math.ceil(Math.log2(N)));
  return { specs, state, R };
}

// Per-bracket progress: [{ pfx, name, seeds, gfDone, gfWonByLB, gf2Done,
// needsReset, champion, runnerUp }]
export function bracketStatus(cfg, res) {
  const inSched = (id) => cfg.sched.some((m) => m.id === id);
  return eventBrackets(cfg).map((bk) => {
    const { state } = resolveBracket(cfg, res, bk);
    const gf = state.get(`${bk.pfx}gf`), gf2 = state.get(`${bk.pfx}gf2`);
    const gfDone = gf && gf.status === "done";
    const gfWonByLB = gfDone && gf.winner === gf.bId;
    const gf2Done = gf2 && gf2.status === "done";
    return {
      pfx: bk.pfx, name: bk.name || "", seeds: bk.seeds,
      gfDone, gfWonByLB, gf2Done,
      needsReset: gfDone && gfWonByLB && !inSched(`${bk.pfx}gf2`),
      champion: gf2Done ? gf2.winner : gfDone ? gf.winner : null,
      runnerUp: gf2Done ? gf2.loser : gfDone ? gf.loser : null,
    };
  });
}

// Refs for a batch of new matches in one bracket. Losing teams ref the
// next game: the most recently beaten free team gets the whistle, then
// earlier losers, alive-but-idle teams last. The first batch uses the bye
// teams, worst seed first — the top seed gets a pass unless they are the
// only option. If every team is on a court, borrow from another match in
// the batch. Best-effort: a match without a candidate just has no ref.
function assignBracketRefs(cfg, res, bracket, matches) {
  const seeds = bracket.seeds || [];
  const seedRank = new Map(seeds.map((g, i) => [g, i]));
  const playing = new Set(matches.flatMap((m) => [m.a.g[0], m.b.g[0]]));
  const refCount = {};
  const lastLoss = new Map();
  let anyBracket = false;
  const mine = (id) => id.startsWith(bracket.pfx || "") &&
    (bracket.pfx || /^(w|l|gf)/.test(id)); // legacy pfx '' owns unprefixed ids
  for (const m of cfg.sched) {
    if (m.ref) refCount[m.ref] = (refCount[m.ref] || 0) + 1;
    if (!m.br || !mine(m.id)) continue;
    anyBracket = true;
    const s = seriesScore(m, res);
    if (!s.done) continue;
    const loser = s.aW > s.bW ? m.b.g[0] : m.a.g[0];
    lastLoss.set(loser, Math.max(lastLoss.get(loser) || 0, m.rd));
  }
  const used = new Set();
  const sparingTop = (list) => {
    const noTop = list.filter((g) => g !== seeds[0]);
    return noTop.length ? noTop : list;
  };
  for (const m of matches) {
    const inMatch = new Set([m.a.g[0], m.b.g[0]]);
    let cands = seeds.filter((g) => !inMatch.has(g) && !used.has(g) && !playing.has(g));
    if (!anyBracket) {
      cands.sort((a, b) => seedRank.get(b) - seedRank.get(a)); // worst seed refs first
      cands = sparingTop(cands);
    } else {
      cands.sort((a, b) =>
        (lastLoss.get(b) || 0) - (lastLoss.get(a) || 0) ||
        (refCount[a] || 0) - (refCount[b] || 0) ||
        seedRank.get(b) - seedRank.get(a));
    }
    if (!cands.length) {
      const alt = matches
        .filter((x) => x !== m)
        .flatMap((x) => [x.a.g[0], x.b.g[0]])
        .filter((g) => !used.has(g) && !inMatch.has(g))
        .sort((a, b) => seedRank.get(b) - seedRank.get(a));
      cands = sparingTop(alt);
    }
    if (cands.length) { m.ref = cands[0]; used.add(cands[0]); }
  }
}

// Creates every newly-determined match across all brackets (never a
// deciding game — that is genResetFinal, by director discretion).
export function advanceBracket(cfg, res) {
  if (cfg.stage !== "playoff") return { cfg, error: "Start the playoffs first." };
  const have = new Set(cfg.sched.map((m) => m.id));
  const rd = (cfg.rds || 0) + 1;
  const created = [];
  let courtIdx = 0;
  for (const bk of eventBrackets(cfg)) {
    const { specs, state, R } = resolveBracket(cfg, res, bk);
    const toCreate = specs.filter(
      (sp) => sp.id !== `${bk.pfx}gf2` && state.get(sp.id).status === "ready" && !have.has(sp.id)
    );
    if (!toCreate.length) continue;
    const matches = toCreate.map((sp) => ({
      id: sp.id, rd, ct: (courtIdx++ % cfg.courts) + 1,
      a: { g: [state.get(sp.id).aId] }, b: { g: [state.get(sp.id).bId] },
      br: sp.br, brd: sp.brd, bo: sp.bo, lbl: bracketLabel(sp, R, bk.name),
    }));
    assignBracketRefs(cfg, res, bk, matches);
    created.push(...matches);
  }
  if (created.length === 0) {
    const bs = bracketStatus(cfg, res);
    const reset = bs.find((b) => b.needsReset);
    if (reset)
      return { cfg, error: `Losers-bracket team won the ${reset.name ? reset.name + " " : ""}grand final — generate the deciding game, or end the event to let it stand.` };
    if (bs.length && bs.every((b) => b.champion))
      return { cfg, error: "All brackets are complete — end the event to post final standings." };
    return { cfg, error: "Nothing new to post — finish the matches on the board." };
  }
  return { cfg: { ...cfg, sched: [...cfg.sched, ...created], rds: rd } };
}

export function genResetFinal(cfg, res, pfx = "") {
  const bk = eventBrackets(cfg).find((b) => (b.pfx || "") === pfx);
  if (!bk) return { cfg, error: "No such bracket." };
  const bs = bracketStatus(cfg, res).find((b) => (b.pfx || "") === pfx);
  if (!bs || !bs.needsReset) return { cfg, error: "No deciding game is needed." };
  const { state } = resolveBracket(cfg, res, bk);
  const gf = state.get(`${pfx}gf`);
  const rd = (cfg.rds || 0) + 1;
  const m = {
    id: `${pfx}gf2`, rd, ct: 1,
    a: { g: [gf.winner] }, b: { g: [gf.loser] },
    br: "gf2", brd: 1, bo: 1, lbl: bracketLabel({ br: "gf2" }, 1, bk.name),
  };
  assignBracketRefs(cfg, res, bk, [m]);
  return { cfg: { ...cfg, sched: [...cfg.sched, m], rds: rd } };
}

/* ---------------------- levels, seeding & placements ---------------------- */
export const LEVELS = ["Open", "AA", "A", "BB", "B", "Rec"];
export const lvlRank = (lvl) => {
  const i = LEVELS.indexOf(lvl);
  return i === -1 ? LEVELS.length : i;
};
export const poolName = (p) => String.fromCharCode(64 + p); // 1→A, 2→B…

// Spread teams across nPools by level (strongest levels in pool A),
// contiguous chunks as even as possible. Returns groups with .pool set.
export function autoAssignPools(groups, nPools) {
  const sorted = [...groups].sort((x, y) =>
    lvlRank(x.lvl) - lvlRank(y.lvl) || x.name.localeCompare(y.name));
  const per = Math.ceil(sorted.length / nPools);
  const poolOf = new Map(sorted.map((g, i) => [g.id, Math.min(nPools, Math.floor(i / per) + 1)]));
  return groups.map((g) => ({ ...g, pool: nPools > 1 ? poolOf.get(g.id) : 1 }));
}

// Seed order for one bracket's teams: per-pool standings rank, pools
// interleaved (A1, B1, A2, B2…) so same-pool rematches come late.
export function seedBracket(cfg, res, teamIds) {
  const member = new Set(teamIds);
  const rows = calcStandings(cfg, res).filter((r) => member.has(r.id));
  const byPool = new Map();
  for (const r of rows) {
    const p = (groupOf(cfg, r.id) || {}).pool || 1;
    if (!byPool.has(p)) byPool.set(p, []);
    byPool.get(p).push(r.id);
  }
  const lists = [...byPool.entries()].sort((x, y) => x[0] - y[0]).map(([, l]) => l);
  const out = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length), 0); i++)
    for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

// brackets: array of team-id arrays (seed order), one per playoff bracket.
// Empty input brackets are skipped; a non-empty bracket that validates to
// fewer than 2 real teams is an error, never a silent drop.
export function startPlayoffs(cfg, res, { brackets, po }) {
  const input = (brackets || []).filter((seeds) => (seeds || []).length > 0);
  const lists = input.map((seeds) => [...new Set(seeds)].filter((gid) => groupOf(cfg, gid)));
  if (!lists.length || lists.some((seeds) => seeds.length < 2))
    return { cfg, error: "Every bracket needs at least 2 teams." };
  const named = lists.map((seeds, i) => ({
    pfx: `b${i + 1}`,
    name: lists.length > 1 ? poolName(i + 1) : "",
    seeds,
  }));
  const next = {
    ...cfg, stage: "playoff", brackets: named, seeds: [],
    po: { g12: (po && po.g12) || 21, g3: (po && po.g3) || 15 },
  };
  return advanceBracket(next, res);
}

// Final placement order for one bracket: champion, runner-up, then by how
// deep each team survived; ties broken by seed. Sensible mid-bracket too.
export function calcPlacements(cfg, res, bracket) {
  const { specs, state } = resolveBracket(cfg, res, bracket);
  const bs = bracketStatus(cfg, res).find((b) => (b.pfx || "") === (bracket.pfx || ""));
  const seeds = bracket.seeds || [];
  const score = new Map(seeds.map((gid, i) => [gid, { depth: 0, out: false, seed: i }]));
  specs.forEach((sp, idx) => {
    const st = state.get(sp.id);
    for (const gid of [st.aId, st.bId]) {
      if (gid && score.has(gid)) score.get(gid).depth = idx + 1;
    }
    if (st.status === "done" && (sp.br === "l" || sp.br === "gf2") && score.has(st.loser)) {
      score.get(st.loser).out = idx + 1; // second loss — eliminated here
    }
  });
  const rank = (gid) => {
    if (gid === bs.champion) return 9e9;
    if (gid === bs.runnerUp) return 8e9;
    const s = score.get(gid);
    return s.out ? s.out : 1e6 + s.depth; // alive teams above eliminated ones
  };
  return seeds
    .map((gid) => ({ id: gid, label: groupLabel(cfg, gid) }))
    .sort((x, y) => rank(y.id) - rank(x.id) || score.get(x.id).seed - score.get(y.id).seed);
}
