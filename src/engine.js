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

// Round robin within each pool, merged round-by-round. poolGames=2 emits
// each matchup twice, back to back on the same court.
export function genPoolPlay(cfg) {
  const pools = cfg.pools === 2 ? 2 : 1;
  const games = cfg.poolGames === 2 ? 2 : 1;
  const byPool = [[], []];
  for (const g of cfg.groups) byPool[pools === 2 && g.pool === 2 ? 1 : 0].push(g.id);
  const roundLists = [circleRounds(byPool[0]), pools === 2 ? circleRounds(byPool[1]) : []];
  const rds = Math.max(roundLists[0].length, roundLists[1].length);
  const sched = [];
  const byes = {};
  let seq = cfg.mseq || 0;
  for (let r = 0; r < rds; r++) {
    const rd = r + 1;
    let courtIdx = 0;
    roundLists.forEach((rounds, pi) => {
      const round = rounds[r];
      if (!round) return;
      if (round.bye) byes[rd] = [...(byes[rd] || []), round.bye];
      for (const [x, y] of round.pairs) {
        const ct = (courtIdx++ % cfg.courts) + 1;
        for (let gI = 0; gI < games; gI++) {
          sched.push({
            id: "m" + ++seq, rd, ct,
            a: { g: [x] }, b: { g: [y] },
            ...(pools === 2 ? { pl: pi + 1 } : {}),
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
// All potential matches for a seeded double-elim bracket, in dependency
// order. Sides reference seeds or winners/losers of earlier matches.
export function buildBracket(seedIds) {
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
      id: `w1s${s}`, br: "w", brd: 1, bo: 3,
      a: { seed: seedAt(ord[2 * s - 2]) }, b: { seed: seedAt(ord[2 * s - 1]) },
    });
  for (let r = 2; r <= R; r++)
    for (let s = 1; s <= P / 2 ** r; s++)
      specs.push({
        id: `w${r}s${s}`, br: "w", brd: r, bo: 3,
        a: { w: `w${r - 1}s${2 * s - 1}` }, b: { w: `w${r - 1}s${2 * s}` },
      });
  if (R >= 2) {
    for (let s = 1; s <= P / 4; s++)
      specs.push({
        id: `l1s${s}`, br: "l", brd: 1, bo: 1,
        a: { l: `w1s${2 * s - 1}` }, b: { l: `w1s${2 * s}` },
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
            id: `l${r}s${s}`, br: "l", brd: r, bo: 1,
            a: { w: `l${r - 1}s${s}` }, b: { l: `w${k}s${drop}` },
          });
        } else {
          specs.push({
            id: `l${r}s${s}`, br: "l", brd: r, bo: 1,
            a: { w: `l${r - 1}s${2 * s - 1}` }, b: { w: `l${r - 1}s${2 * s}` },
          });
        }
      }
    }
  }
  specs.push({
    id: "gf", br: "gf", brd: 1, bo: 3,
    a: { w: `w${R}s1` },
    b: R >= 2 ? { w: `l${2 * R - 2}s1` } : { l: "w1s1" },
  });
  specs.push({ id: "gf2", br: "gf2", brd: 1, bo: 1, a: { w: "gf" }, b: { l: "gf" } });
  return specs;
}

export function bracketLabel(sp, R) {
  if (sp.br === "w") return sp.brd === R ? "WINNERS FINAL" : `WINNERS R${sp.brd}`;
  if (sp.br === "l") return sp.brd === 2 * R - 2 ? "LOSERS FINAL" : `LOSERS R${sp.brd}`;
  if (sp.br === "gf2") return "DECIDING GAME";
  return "GRAND FINAL";
}

// Resolves every bracket slot from seeds + results. Sides are a team id,
// null (bye), or undefined (not yet determined). status: 'pending' |
// 'bye' (auto-advance, no match played) | 'ready' | 'done'.
export function resolveBracket(cfg, res) {
  const specs = buildBracket(cfg.seeds || []);
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
  return { specs, state, R: Math.log2(cfg.seeds && cfg.seeds.length > 2 ? 2 ** Math.ceil(Math.log2(cfg.seeds.length)) : 2) };
}

export function bracketStatus(cfg, res) {
  const { state } = resolveBracket(cfg, res);
  const gf = state.get("gf"), gf2 = state.get("gf2");
  const inSched = (id) => cfg.sched.some((m) => m.id === id);
  const gfDone = gf && gf.status === "done";
  const gfWonByLB = gfDone && gf.winner === gf.bId;
  const gf2Done = gf2 && gf2.status === "done";
  return {
    gfDone, gfWonByLB, gf2Done,
    needsReset: gfDone && gfWonByLB && !inSched("gf2"),
    champion: gf2Done ? gf2.winner : gfDone ? gf.winner : null,
    runnerUp: gf2Done ? gf2.loser : gfDone ? gf.loser : null,
  };
}

// Creates every newly-determined bracket match (never the deciding game —
// that's genResetFinal, by director discretion).
export function advanceBracket(cfg, res) {
  if (cfg.stage !== "playoff") return { cfg, error: "Start the playoffs first." };
  const { specs, state, R } = resolveBracket(cfg, res);
  const have = new Set(cfg.sched.map((m) => m.id));
  const toCreate = specs.filter(
    (sp) => sp.id !== "gf2" && state.get(sp.id).status === "ready" && !have.has(sp.id)
  );
  if (toCreate.length === 0) {
    const bs = bracketStatus(cfg, res);
    if (bs.needsReset)
      return { cfg, error: "Losers-bracket team won the grand final — generate the deciding game, or end the event to let it stand." };
    if (bs.champion)
      return { cfg, error: "Bracket is complete — end the event to post final standings." };
    return { cfg, error: "Nothing new to post — finish the matches on the board." };
  }
  const rd = (cfg.rds || 0) + 1;
  const matches = toCreate.map((sp, i) => ({
    id: sp.id, rd, ct: (i % cfg.courts) + 1,
    a: { g: [state.get(sp.id).aId] }, b: { g: [state.get(sp.id).bId] },
    br: sp.br, brd: sp.brd, bo: sp.bo, lbl: bracketLabel(sp, R),
  }));
  return { cfg: { ...cfg, sched: [...cfg.sched, ...matches], rds: rd } };
}

export function genResetFinal(cfg, res) {
  const bs = bracketStatus(cfg, res);
  if (!bs.needsReset) return { cfg, error: "No deciding game is needed." };
  const { state } = resolveBracket(cfg, res);
  const gf = state.get("gf");
  const rd = (cfg.rds || 0) + 1;
  const m = {
    id: "gf2", rd, ct: 1,
    a: { g: [gf.winner] }, b: { g: [gf.loser] },
    br: "gf2", brd: 1, bo: 1, lbl: "DECIDING GAME",
  };
  return { cfg: { ...cfg, sched: [...cfg.sched, m], rds: rd } };
}

/* ---------------------- seeding & placements ---------------------- */
// Pool standings order; with two pools, cross-seeded A1,B1,A2,B2,…
export function seedFromStandings(cfg, res) {
  const rows = calcStandings(cfg, res);
  if (cfg.pools !== 2) return rows.map((r) => r.id);
  const byPool = [[], []];
  for (const r of rows) {
    const g = groupOf(cfg, r.id);
    byPool[g && g.pool === 2 ? 1 : 0].push(r.id);
  }
  const out = [];
  for (let i = 0; i < Math.max(byPool[0].length, byPool[1].length); i++) {
    if (byPool[0][i]) out.push(byPool[0][i]);
    if (byPool[1][i]) out.push(byPool[1][i]);
  }
  return out;
}

export function startPlayoffs(cfg, res, { seeds, po }) {
  const uniq = [...new Set(seeds)].filter((gid) => groupOf(cfg, gid));
  if (uniq.length < 2) return { cfg, error: "Need at least 2 teams in the bracket." };
  const next = {
    ...cfg, stage: "playoff", seeds: uniq,
    po: { g12: (po && po.g12) || 21, g3: (po && po.g3) || 15 },
  };
  return advanceBracket(next, res);
}

// Final placement order: champion, runner-up, then by how deep each team
// survived; ties broken by seed. Sensible mid-bracket too (used the moment
// the director ends the event).
export function calcPlacements(cfg, res) {
  const { specs, state } = resolveBracket(cfg, res);
  const bs = bracketStatus(cfg, res);
  const seeds = cfg.seeds || [];
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
