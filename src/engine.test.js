import { describe, it, expect } from "vitest";
import {
  genRoundRobin, genPairsRound, genMixRound,
  calcStandings, buildPairs, buildTeams,
  sideStatIds, pk, uid,
} from "./engine.js";

/* The engine shuffles with Math.random, so every assertion here is an
   invariant that must hold on any draw; randomized cases run several
   iterations to make flakes loud. */

const ITER = 25;

const baseCfg = (over = {}) => ({
  v: 1, code: "TEST", name: "Test", format: "pairs", teamSize: 2,
  courts: 2, pointsTo: 21, pin: "0000", status: "live", created: 0,
  roster: [], groups: null, sched: [], rds: 0, mseq: 0,
  byes: {}, sit: {}, inact: [], sat: {},
  ...over,
});

const mkRoster = (n) => Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i }));
const mkPairGroups = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: "g" + i, name: "Pair " + (i + 1), players: ["p" + 2 * i, "p" + (2 * i + 1)] }));

const spread = (counts) => Math.max(...counts) - Math.min(...counts);

/* ---------------- round robin (fixed teams) ---------------- */
describe("genRoundRobin", () => {
  it("5 teams: 10 unique matchups, one bye each, 5 rounds", () => {
    const groups = Array.from({ length: 5 }, (_, i) => ({ id: "g" + i, name: "T" + i, players: [] }));
    const cfg = genRoundRobin(baseCfg({ format: "teams", groups, courts: 2 }));
    expect(cfg.rds).toBe(5);
    expect(cfg.sched).toHaveLength(10);
    const matchups = new Set(cfg.sched.map((m) => pk(m.a.g[0], m.b.g[0])));
    expect(matchups.size).toBe(10); // every pair of teams exactly once
    const byeList = Object.values(cfg.byes).flat();
    expect(Object.keys(cfg.byes)).toHaveLength(5); // one bye row per round
    expect(new Set(byeList).size).toBe(5); // each team byes exactly once
    for (const m of cfg.sched) {
      expect(m.ct).toBeGreaterThanOrEqual(1);
      expect(m.ct).toBeLessThanOrEqual(cfg.courts);
    }
  });

  it("4 teams: 6 matches, 3 rounds, no byes, each team plays once per round", () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({ id: "g" + i, name: "T" + i, players: [] }));
    const cfg = genRoundRobin(baseCfg({ format: "teams", groups }));
    expect(cfg.rds).toBe(3);
    expect(cfg.sched).toHaveLength(6);
    expect(Object.keys(cfg.byes)).toHaveLength(0);
    for (let rd = 1; rd <= 3; rd++) {
      const inRound = cfg.sched.filter((m) => m.rd === rd).flatMap((m) => [m.a.g[0], m.b.g[0]]);
      expect(new Set(inRound).size).toBe(4);
    }
  });
});

/* ---------------- rotating pairs ---------------- */
describe("genPairsRound", () => {
  it("bye spread stays within 1 over 6 rounds (5 pairs → one bye per round)", () => {
    for (let t = 0; t < ITER; t++) {
      let cfg = baseCfg({ roster: mkRoster(10), groups: mkPairGroups(5) });
      for (let r = 0; r < 6; r++) {
        const out = genPairsRound(cfg);
        expect(out.error).toBeUndefined();
        cfg = out.cfg;
      }
      const byes = Object.values(cfg.byes).flat();
      expect(byes).toHaveLength(6); // exactly one pair sits each round
      const counts = cfg.groups.map((g) => byes.filter((x) => x === g.id).length);
      expect(spread(counts)).toBeLessThanOrEqual(1);
    }
  });

  it("7 pairs: one bye + one 4s match + one 2v2 each round; fairness holds", () => {
    for (let t = 0; t < ITER; t++) {
      let cfg = baseCfg({ roster: mkRoster(14), groups: mkPairGroups(7) });
      for (let r = 0; r < 6; r++) {
        const before = cfg.sched.length;
        cfg = genPairsRound(cfg).cfg;
        const round = cfg.sched.slice(before);
        expect(round).toHaveLength(2);
        const sizes = round.map((m) => m.a.g.length + m.b.g.length).sort();
        expect(sizes).toEqual([2, 4]); // a 2v2 tail and a pairs-combined 4s
        expect(cfg.byes[cfg.rds]).toHaveLength(1);
      }
      const byes = Object.values(cfg.byes).flat();
      const counts = cfg.groups.map((g) => byes.filter((x) => x === g.id).length);
      expect(spread(counts)).toBeLessThanOrEqual(1);
    }
  });

  it("8 pairs: no byes, two 4s matches, every active pair plays every round", () => {
    let cfg = baseCfg({ roster: mkRoster(16), groups: mkPairGroups(8) });
    for (let r = 0; r < 4; r++) {
      const before = cfg.sched.length;
      cfg = genPairsRound(cfg).cfg;
      const round = cfg.sched.slice(before);
      expect(round).toHaveLength(2);
      const playing = round.flatMap((m) => [...m.a.g, ...m.b.g]);
      expect(new Set(playing).size).toBe(8);
      expect(cfg.byes[cfg.rds]).toBeUndefined();
    }
  });

  it("inactive pairs are excluded; fewer than 2 active is an error", () => {
    let cfg = baseCfg({ roster: mkRoster(10), groups: mkPairGroups(5), inact: ["g0"] });
    cfg = genPairsRound(cfg).cfg;
    const playing = cfg.sched.flatMap((m) => [...m.a.g, ...m.b.g]);
    expect(playing).not.toContain("g0");
    const dead = baseCfg({ roster: mkRoster(10), groups: mkPairGroups(5), inact: ["g0", "g1", "g2", "g3"] });
    expect(genPairsRound(dead).error).toBeTruthy();
  });
});

/* ---------------- pickup mix ---------------- */
describe("genMixRound", () => {
  it("sit spread stays within 1 over 6 rounds (10 players, 2s, 2 courts)", () => {
    for (let t = 0; t < ITER; t++) {
      let cfg = baseCfg({
        format: "mix", teamSize: 2, courts: 2,
        roster: mkRoster(10), sat: Object.fromEntries(mkRoster(10).map((r) => [r.id, 0])),
      });
      for (let r = 0; r < 6; r++) {
        const out = genMixRound(cfg);
        expect(out.error).toBeUndefined();
        cfg = out.cfg;
        const round = cfg.sched.filter((m) => m.rd === cfg.rds);
        expect(round).toHaveLength(2); // 2 courts × 2v2 = 8 playing, 2 sitting
        for (const m of round) {
          expect(m.a.p).toHaveLength(2);
          expect(m.b.p).toHaveLength(2);
        }
        expect(cfg.sit[cfg.rds]).toHaveLength(2);
      }
      expect(spread(Object.values(cfg.sat))).toBeLessThanOrEqual(1);
    }
  });

  it("small-group fallback: 5 players at 4s shrinks to one 2v2 with one sitter", () => {
    for (let t = 0; t < ITER; t++) {
      const out = genMixRound(baseCfg({ format: "mix", teamSize: 4, courts: 2, roster: mkRoster(5) }));
      expect(out.error).toBeUndefined();
      const round = out.cfg.sched;
      expect(round).toHaveLength(1);
      expect(round[0].a.p).toHaveLength(2);
      expect(round[0].b.p).toHaveLength(2);
      expect(out.cfg.sit[1]).toHaveLength(1);
    }
  });

  it("walk-up joining at max sat count never strands the newcomer", () => {
    // simulate the live walk-up rule: new player enters with sat = current max
    for (let t = 0; t < ITER; t++) {
      let cfg = baseCfg({
        format: "mix", teamSize: 2, courts: 1,
        roster: mkRoster(5), sat: Object.fromEntries(mkRoster(5).map((r) => [r.id, 0])),
      });
      cfg = genMixRound(cfg).cfg; // someone sits round 1
      const maxSat = Math.max(0, ...Object.values(cfg.sat));
      cfg = { ...cfg, roster: [...cfg.roster, { id: "new", name: "New" }], sat: { ...cfg.sat, new: maxSat } };
      cfg = genMixRound(cfg).cfg;
      cfg = genMixRound(cfg).cfg;
      expect(spread(Object.values(cfg.sat))).toBeLessThanOrEqual(1);
    }
  });

  it("fewer than 4 active players is an error", () => {
    expect(genMixRound(baseCfg({ format: "mix", roster: mkRoster(3) })).error).toBeTruthy();
  });
});

/* ---------------- standings ---------------- */
describe("calcStandings", () => {
  it("credits wins, losses, and point differential to every id on each side", () => {
    const cfg = baseCfg({
      format: "mix",
      roster: mkRoster(4),
      sched: [
        { id: "m1", rd: 1, ct: 1, a: { p: ["p0", "p1"] }, b: { p: ["p2", "p3"] } },
        { id: "m2", rd: 2, ct: 1, a: { p: ["p0", "p2"] }, b: { p: ["p1", "p3"] } },
      ],
    });
    const res = { m1: { a: 21, b: 15 }, m2: { a: 18, b: 21 } };
    const table = calcStandings(cfg, res);
    const row = (id) => table.find((r) => r.id === id);
    expect(row("p0")).toMatchObject({ w: 1, l: 1, pf: 39, pa: 36, gp: 2 });
    expect(row("p1")).toMatchObject({ w: 2, l: 0, pf: 42, pa: 33, gp: 2 });
    expect(row("p2")).toMatchObject({ w: 0, l: 2, pf: 33, pa: 42, gp: 2 });
    expect(row("p3")).toMatchObject({ w: 1, l: 1, pf: 36, pa: 39, gp: 2 });
    expect(table[0].id).toBe("p1"); // most wins first
  });

  it("seeds 0–0 rows, ranks by wins then diff then points-for", () => {
    const groups = [
      { id: "gA", name: "A", players: [] },
      { id: "gB", name: "B", players: [] },
      { id: "gC", name: "C", players: [] },
    ];
    const cfg = baseCfg({
      format: "teams", groups,
      sched: [{ id: "m1", rd: 1, ct: 1, a: { g: ["gA"] }, b: { g: ["gB"] } }],
    });
    const table = calcStandings(cfg, { m1: { a: 21, b: 19 } });
    expect(table).toHaveLength(3); // gC shows up with a 0–0 line
    expect(table[0].id).toBe("gA");
    expect(table.find((r) => r.id === "gC")).toMatchObject({ w: 0, l: 0, gp: 0 });
  });

  it("credits both pairs on a combined 4s side", () => {
    const cfg = baseCfg({
      roster: mkRoster(8), groups: mkPairGroups(4),
      sched: [{ id: "m1", rd: 1, ct: 1, a: { g: ["g0", "g1"] }, b: { g: ["g2", "g3"] } }],
    });
    const table = calcStandings(cfg, { m1: { a: 21, b: 10 } });
    const row = (id) => table.find((r) => r.id === id);
    for (const gid of ["g0", "g1"]) expect(row(gid)).toMatchObject({ w: 1, l: 0, pf: 21, pa: 10 });
    for (const gid of ["g2", "g3"]) expect(row(gid)).toMatchObject({ w: 0, l: 1, pf: 10, pa: 21 });
  });
});

/* ---------------- roster → groups ---------------- */
describe("buildPairs", () => {
  it("honors mutual partner requests, then one-way, then fills randomly", () => {
    for (let t = 0; t < ITER; t++) {
      const roster = [
        { id: "a", name: "Ann" }, { id: "b", name: "Ben" },
        { id: "c", name: "Cam" }, { id: "d", name: "Dee" },
        { id: "e", name: "Eli" }, { id: "f", name: "Fay" },
      ];
      const regs = [
        { name: "Ann", extra: "Ben" }, { name: "Ben", extra: "Ann" }, // mutual
        { name: "Cam", extra: "Dee" },                                  // one-way
        { name: "Eli", extra: "" }, { name: "Fay", extra: "" },
      ];
      const groups = buildPairs(roster, regs);
      expect(groups).toHaveLength(3);
      const groupWith = (pid) => groups.find((g) => g.players.includes(pid));
      expect(groupWith("a")).toBe(groupWith("b"));
      expect(groupWith("c")).toBe(groupWith("d"));
      expect(groupWith("e")).toBe(groupWith("f"));
    }
  });

  it("mutual request beats a conflicting one-way claim on the same player", () => {
    for (let t = 0; t < ITER; t++) {
      const roster = [
        { id: "a", name: "Ann" }, { id: "b", name: "Ben" },
        { id: "c", name: "Cam" }, { id: "d", name: "Dee" },
      ];
      const regs = [
        { name: "Cam", extra: "Ann" },                                  // one-way at Ann
        { name: "Ann", extra: "Ben" }, { name: "Ben", extra: "Ann" }, // mutual wins
        { name: "Dee", extra: "" },
      ];
      const groups = buildPairs(roster, regs);
      const groupWith = (pid) => groups.find((g) => g.players.includes(pid));
      expect(groupWith("a")).toBe(groupWith("b"));
      expect(groupWith("c")).toBe(groupWith("d"));
    }
  });

  it("odd roster leaves exactly one Solo group", () => {
    const roster = mkRoster(7).map((r, i) => ({ ...r, name: "N" + i }));
    const regs = roster.map((r) => ({ name: r.name, extra: "" }));
    const groups = buildPairs(roster, regs);
    const solo = groups.filter((g) => g.players.length === 1);
    expect(solo).toHaveLength(1);
    expect(solo[0].name).toBe("Solo");
    expect(groups.flatMap((g) => g.players)).toHaveLength(7);
  });
});

describe("buildTeams", () => {
  it("groups by team name, tops up short named teams, letters the rest", () => {
    for (let t = 0; t < ITER; t++) {
      const roster = Array.from({ length: 9 }, (_, i) => ({ id: "p" + i, name: "N" + i }));
      const regs = [
        { name: "N0", extra: "Net Gains" }, { name: "N1", extra: "net gains" }, // same team, case-blind
        { name: "N2", extra: "Spiked" },                                          // short named team
        ...Array.from({ length: 6 }, (_, i) => ({ name: "N" + (i + 3), extra: "" })),
      ];
      const groups = buildTeams(roster, regs, 3);
      expect(groups).toHaveLength(3);
      const netGains = groups.find((g) => g.name === "Net Gains");
      const spiked = groups.find((g) => g.name === "Spiked");
      expect(netGains.players).toContain("p0");
      expect(netGains.players).toContain("p1");
      expect(spiked.players).toContain("p2");
      for (const g of groups) expect(g.players).toHaveLength(3); // everyone topped up evenly
      expect(new Set(groups.flatMap((g) => g.players)).size).toBe(9);
    }
  });

  it("never strands a single leftover on a team of one", () => {
    for (let t = 0; t < ITER; t++) {
      const roster = Array.from({ length: 7 }, (_, i) => ({ id: "p" + i, name: "N" + i }));
      const regs = roster.map((r) => ({ name: r.name, extra: "" }));
      const groups = buildTeams(roster, regs, 3); // 3+3+1 → the 1 joins a team
      expect(groups).toHaveLength(2);
      const sizes = groups.map((g) => g.players.length).sort();
      expect(sizes).toEqual([3, 4]);
    }
  });

  it("oversubscribed team name spills extras into auto teams", () => {
    const roster = Array.from({ length: 4 }, (_, i) => ({ id: "p" + i, name: "N" + i }));
    const regs = roster.map((r) => ({ name: r.name, extra: "Crowd" }));
    const groups = buildTeams(roster, regs, 2);
    const crowd = groups.find((g) => g.name === "Crowd");
    expect(crowd.players).toHaveLength(2);
    expect(new Set(groups.flatMap((g) => g.players)).size).toBe(4);
  });
});

/* ---------------- misc ---------------- */
describe("helpers", () => {
  it("pk is order-independent", () => {
    expect(pk("a", "b")).toBe(pk("b", "a"));
  });
  it("uid yields 6-char ids", () => {
    expect(uid()).toMatch(/^[a-z0-9]{6}$/);
  });
  it("sideStatIds picks pairs vs players correctly", () => {
    expect(sideStatIds({}, { g: ["g1", "g2"] })).toEqual(["g1", "g2"]);
    expect(sideStatIds({}, { p: ["p1"] })).toEqual(["p1"]);
  });
});

/* =====================================================================
   Pool play + double-elimination playoffs
   ===================================================================== */
import {
  genPoolPlay, matchGames, seriesScore, matchDone, getGameTarget,
  buildBracket, resolveBracket, bracketStatus, advanceBracket,
  genResetFinal, seedBracket, startPlayoffs, calcPlacements,
  eventBrackets, autoAssignPools, LEVELS, lvlRank, poolName,
  genRoundRobin,
} from "./engine.js";

const mkTeams = (n, pool) =>
  Array.from({ length: n }, (_, i) => ({
    id: "t" + i, name: "T" + i, players: [],
    ...(pool ? { pool: (i % 2) + 1 } : {}),
  }));

describe("genPoolPlay", () => {
  it("single pool, single game: identical matchup set to genRoundRobin", () => {
    const groups = mkTeams(5);
    const a = genPoolPlay(baseCfg({ format: "teams", groups, pools: 1, poolGames: 1, courts: 2 }));
    const b = genRoundRobin(baseCfg({ format: "teams", groups, courts: 2 }));
    const key = (m) => pk(m.a.g[0], m.b.g[0]);
    expect(a.sched.map(key).sort()).toEqual(b.sched.map(key).sort());
    expect(a.rds).toBe(5);
    expect(Object.values(a.byes).flat()).toHaveLength(5);
  });

  it("poolGames=2 plays each matchup twice, back to back on the same court", () => {
    const cfg = genPoolPlay(baseCfg({ format: "teams", groups: mkTeams(4), pools: 1, poolGames: 2, courts: 2 }));
    expect(cfg.sched).toHaveLength(12); // 6 matchups × 2
    const seen = new Map();
    for (const m of cfg.sched) {
      const k = pk(m.a.g[0], m.b.g[0]);
      seen.set(k, [...(seen.get(k) || []), m]);
    }
    expect(seen.size).toBe(6);
    for (const [, ms] of seen) {
      expect(ms).toHaveLength(2);
      expect(ms[0].rd).toBe(ms[1].rd);
      expect(ms[0].ct).toBe(ms[1].ct);
    }
  });

  it("two pools: round robin within each, never across", () => {
    const groups = mkTeams(8, true); // pools 1/2 alternating
    const cfg = genPoolPlay(baseCfg({ format: "teams", groups, pools: 2, poolGames: 1, courts: 4 }));
    expect(cfg.sched).toHaveLength(12); // two 4-team RRs
    const poolOf = (gid) => groups.find((g) => g.id === gid).pool;
    for (const m of cfg.sched) {
      expect(poolOf(m.a.g[0])).toBe(poolOf(m.b.g[0]));
      expect(m.pl).toBe(poolOf(m.a.g[0]));
    }
    expect(cfg.rds).toBe(3);
  });

  it("uneven pools (5/4) run side by side with pool-A byes", () => {
    const groups = [...mkTeams(5).map((g) => ({ ...g, pool: 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: "u" + i, name: "U" + i, players: [], pool: 2 }))];
    const cfg = genPoolPlay(baseCfg({ format: "teams", groups, pools: 2, courts: 4 }));
    expect(cfg.rds).toBe(5);
    expect(cfg.sched).toHaveLength(16); // 10 + 6
    expect(Object.values(cfg.byes).flat()).toHaveLength(5); // pool A bye each round
  });

  it("three pools of three: independent round robins, bye team refs each", () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({
      id: "t" + i, name: "T" + i, players: [], pool: Math.floor(i / 3) + 1,
    }));
    const cfg = genPoolPlay(baseCfg({ format: "teams", groups, pools: 3, courts: 3 }));
    expect(cfg.sched).toHaveLength(9); // 3 matches per 3-team pool
    expect(cfg.rds).toBe(3);
    const poolOf = (gid) => groups.find((g) => g.id === gid).pool;
    for (const m of cfg.sched) {
      expect(poolOf(m.a.g[0])).toBe(poolOf(m.b.g[0]));
      expect(m.pl).toBe(poolOf(m.a.g[0]));
      expect(m.ref).toBeTruthy(); // 3-team pool: the resting team refs
      expect(poolOf(m.ref)).toBe(m.pl);
      expect([m.a.g[0], m.b.g[0]]).not.toContain(m.ref);
    }
    for (let rd = 1; rd <= 3; rd++) expect(cfg.byes[rd]).toHaveLength(3);
  });
});

describe("series scoring", () => {
  it("bo3 series resolves at two game wins", () => {
    const m = { id: "b1w1s1", br: "w", bo: 3 };
    const res = { b1w1s1g1: { a: 21, b: 15 } };
    expect(seriesScore(m, res).done).toBe(false);
    res.b1w1s1g2 = { a: 19, b: 21 };
    expect(seriesScore(m, res).done).toBe(false);
    res.b1w1s1g3 = { a: 15, b: 10 };
    const s = seriesScore(m, res);
    expect(s).toMatchObject({ aW: 2, bW: 1, done: true });
    expect(matchDone(m, res)).toBe(true);
  });

  it("bo1 (losers bracket) resolves after one game; pool matches use plain ids", () => {
    expect(matchDone({ id: "b1l1s1", br: "l", bo: 1 }, { b1l1s1g1: { a: 21, b: 12 } })).toBe(true);
    expect(matchDone({ id: "m4" }, { m4: { a: 21, b: 12 } })).toBe(true);
    expect(matchGames({ id: "m4" }, {})).toEqual([]);
  });

  it("game targets: pool uses pointsTo; playoffs use po with short game 3", () => {
    const cfg = baseCfg({ pointsTo: 25, po: { g12: 21, g3: 15 } });
    expect(getGameTarget(cfg, { id: "m1" }, 0)).toBe(25);
    expect(getGameTarget(cfg, { id: "b1w1s1", br: "w", bo: 3 }, 0)).toBe(21);
    expect(getGameTarget(cfg, { id: "b1w1s1", br: "w", bo: 3 }, 2)).toBe(15);
    expect(getGameTarget(cfg, { id: "b1l1s1", br: "l", bo: 1 }, 0)).toBe(21);
    expect(getGameTarget(cfg, { id: "b1gf2", br: "gf2", bo: 1 }, 0)).toBe(15);
  });
});

describe("levels & seeding", () => {
  it("level order ranks Open strongest, unknown last", () => {
    expect(LEVELS).toEqual(["Open", "AA", "A", "BB", "B", "Rec"]);
    expect(lvlRank("Open")).toBeLessThan(lvlRank("AA"));
    expect(lvlRank("Rec")).toBeLessThan(lvlRank(""));
    expect(poolName(1)).toBe("A");
    expect(poolName(3)).toBe("C");
  });

  it("autoAssignPools chunks by level, strongest levels in pool A", () => {
    const gs = [
      { id: "a", name: "Alpha", players: [], lvl: "B" },
      { id: "b", name: "Bravo", players: [], lvl: "Open" },
      { id: "c", name: "Chuck", players: [], lvl: "Rec" },
      { id: "d", name: "Delta", players: [], lvl: "AA" },
      { id: "e", name: "Echo", players: [] }, // no level → sorts last
      { id: "f", name: "Fox", players: [], lvl: "A" },
    ];
    const out = autoAssignPools(gs, 2);
    const pool = (id) => out.find((g) => g.id === id).pool;
    expect(pool("b")).toBe(1); expect(pool("d")).toBe(1); expect(pool("f")).toBe(1);
    expect(pool("a")).toBe(2); expect(pool("c")).toBe(2); expect(pool("e")).toBe(2);
    expect(out.map((g) => g.id)).toEqual(gs.map((g) => g.id)); // original order kept
  });

  it("buildTeams tags groups with the first member's requested level", () => {
    const roster = Array.from({ length: 4 }, (_, i) => ({ id: "p" + i, name: "N" + i }));
    const regs = [
      { name: "N0", extra: "Spiked", lvl: "BB" },
      { name: "N1", extra: "spiked" },
      { name: "N2", extra: "", lvl: "A" },
      { name: "N3", extra: "" },
    ];
    const groups = buildTeams(roster, regs, 2);
    expect(groups.find((g) => g.name === "Spiked").lvl).toBe("BB");
    const auto = groups.find((g) => g.name !== "Spiked");
    expect(auto.lvl).toBe("A");
  });

  it("seedBracket interleaves member pools A1,B1,A2,B2…", () => {
    const groups = [
      { id: "a1", name: "A1", players: [], pool: 1 }, { id: "a2", name: "A2", players: [], pool: 1 },
      { id: "b1", name: "B1", players: [], pool: 2 }, { id: "b2", name: "B2", players: [], pool: 2 },
    ];
    const cfg = baseCfg({
      format: "teams", groups, pools: 2,
      sched: [
        { id: "m1", rd: 1, ct: 1, a: { g: ["a1"] }, b: { g: ["a2"] } },
        { id: "m2", rd: 1, ct: 2, a: { g: ["b1"] }, b: { g: ["b2"] } },
      ],
    });
    const res = { m1: { a: 21, b: 10 }, m2: { a: 21, b: 5 } };
    expect(seedBracket(cfg, res, ["a1", "a2", "b1", "b2"])).toEqual(["a1", "b1", "a2", "b2"]);
    // a bracket containing only one pool's teams: plain standings order
    expect(seedBracket(cfg, res, ["a1", "a2"])).toEqual(["a1", "a2"]);
  });
});

/* ---------- deterministic 4-team bracket walkthrough ---------- */
function winSeries(res, m, winnerId) {
  const winA = m.a.g[0] === winnerId;
  const need = Math.floor((m.bo || 1) / 2) + 1;
  for (let g = 1; g <= need; g++)
    res[m.id + "g" + g] = winA ? { a: 21, b: 15, ts: g } : { a: 15, b: 21, ts: g };
}

describe("double-elim bracket", () => {
  const seeds4 = ["t1", "t2", "t3", "t4"];
  const groups4 = seeds4.map((id) => ({ id, name: id.toUpperCase(), players: [] }));
  const poCfg = (over = {}) =>
    baseCfg({ format: "teams", groups: groups4, courts: 2, stage: "pool", seeds: [], po: {}, ...over });

  it("walks a 4-team bracket through to known placements", () => {
    const res = {};
    let out = startPlayoffs(poCfg(), res, { brackets: [seeds4], po: { g12: 21, g3: 15 } });
    expect(out.error).toBeUndefined();
    let cfg = out.cfg;
    // round 1: seeded pairings 1v4, 2v3, Bo3, labeled, prefixed ids
    const r1 = cfg.sched;
    expect(r1.map((m) => m.id).sort()).toEqual(["b1w1s1", "b1w1s2"]);
    expect(r1[0].a.g[0]).toBe("t1"); expect(r1[0].b.g[0]).toBe("t4");
    expect(r1[1].a.g[0]).toBe("t2"); expect(r1[1].b.g[0]).toBe("t3");
    expect(r1[0].bo).toBe(3);
    expect(r1[0].lbl).toBe("WINNERS R1"); // single bracket: no letter prefix
    // full first round, nobody free: refs borrowed from the other matchup,
    // worst seeds first, top seed spared
    expect(r1[0].ref).toBe("t3");
    expect(r1[1].ref).toBe("t4");
    winSeries(res, r1[0], "t1");
    winSeries(res, r1[1], "t2");
    cfg = advanceBracket(cfg, res).cfg;
    const ids = () => cfg.sched.map((m) => m.id);
    expect(ids()).toContain("b1w2s1"); // winners final t1 v t2
    expect(ids()).toContain("b1l1s1"); // losers r1 t4 v t3
    expect(cfg.sched.find((m) => m.id === "b1w2s1").lbl).toBe("WINNERS FINAL");
    expect(cfg.sched.find((m) => m.id === "b1l1s1").bo).toBe(1); // single-game losers bracket
    winSeries(res, cfg.sched.find((m) => m.id === "b1w2s1"), "t1");
    winSeries(res, cfg.sched.find((m) => m.id === "b1l1s1"), "t3");
    cfg = advanceBracket(cfg, res).cfg;
    expect(ids()).toContain("b1l2s1"); // losers final: t3 v t2 (WB final loser)
    const lf = cfg.sched.find((m) => m.id === "b1l2s1");
    expect(lf.lbl).toBe("LOSERS FINAL");
    expect([lf.a.g[0], lf.b.g[0]].sort()).toEqual(["t2", "t3"]);
    expect(lf.ref).toBe("t4"); // just lost the losers-bracket game → refs the next one
    winSeries(res, lf, "t3");
    cfg = advanceBracket(cfg, res).cfg;
    const gf = cfg.sched.find((m) => m.id === "b1gf");
    expect(gf.lbl).toBe("GRAND FINAL");
    expect(gf.bo).toBe(3);
    expect([gf.a.g[0], gf.b.g[0]]).toEqual(["t1", "t3"]);
    expect(gf.ref).toBe("t2"); // most recently beaten team gets the whistle
    winSeries(res, gf, "t1"); // WB champ holds — no reset
    const [bs] = bracketStatus(cfg, res);
    expect(bs.needsReset).toBe(false);
    expect(bs.champion).toBe("t1");
    expect(advanceBracket(cfg, res).error).toMatch(/complete/);
    expect(calcPlacements(cfg, res, eventBrackets(cfg)[0]).map((p) => p.id)).toEqual(["t1", "t3", "t2", "t4"]);
  });

  it("losers-bracket champ winning the grand final offers (not forces) a deciding game", () => {
    const res = {};
    let cfg = startPlayoffs(poCfg(), res, { brackets: [seeds4], po: {} }).cfg;
    for (const m of cfg.sched) winSeries(res, m, m.a.g[0]); // t1, t2 advance
    cfg = advanceBracket(cfg, res).cfg;
    for (const m of cfg.sched.filter((m) => !matchDone(m, res))) winSeries(res, m, m.a.g[0]);
    cfg = advanceBracket(cfg, res).cfg;
    for (const m of cfg.sched.filter((m) => !matchDone(m, res))) winSeries(res, m, m.a.g[0]);
    cfg = advanceBracket(cfg, res).cfg;
    const gf = cfg.sched.find((m) => m.id === "b1gf");
    winSeries(res, gf, gf.b.g[0]); // LB champ takes the grand final
    let [bs] = bracketStatus(cfg, res);
    expect(bs.needsReset).toBe(true);
    expect(bs.champion).toBe(gf.b.g[0]); // stands if the director ends it here
    expect(advanceBracket(cfg, res).error).toMatch(/deciding game/);
    expect(cfg.sched.find((m) => m.id === "b1gf2")).toBeUndefined(); // never auto-created
    cfg = genResetFinal(cfg, res, "b1").cfg;
    const gf2 = cfg.sched.find((m) => m.id === "b1gf2");
    expect(gf2.bo).toBe(1);
    expect(gf2.lbl).toBe("DECIDING GAME");
    expect(gf2.ref).toBeTruthy(); // an eliminated team refs the decider
    expect([gf2.a.g[0], gf2.b.g[0]]).not.toContain(gf2.ref);
    winSeries(res, gf2, gf2.b.g[0]); // WB champ wins the extra game after all
    [bs] = bracketStatus(cfg, res);
    expect(bs.needsReset).toBe(false);
    expect(bs.champion).toBe(gf2.b.g[0]);
    expect(genResetFinal(cfg, res, "b1").error).toBeTruthy();
  });

  it("full random tournaments stay structurally sound for 3–10 teams", () => {
    for (let N = 3; N <= 10; N++) {
      for (let t = 0; t < 10; t++) {
        const groups = Array.from({ length: N }, (_, i) => ({ id: "t" + i, name: "T" + i, players: [] }));
        const res = {};
        let cfg = startPlayoffs(
          baseCfg({ format: "teams", groups, courts: 3, stage: "pool", seeds: [], po: {} }),
          res, { brackets: [groups.map((g) => g.id)], po: {} }
        ).cfg;
        let guard = 0;
        while (guard++ < 60) {
          for (const m of cfg.sched.filter((m) => m.br && !matchDone(m, res)))
            winSeries(res, m, Math.random() < 0.5 ? m.a.g[0] : m.b.g[0]);
          const adv = advanceBracket(cfg, res);
          if (adv.error) break;
          cfg = adv.cfg;
        }
        let [bs] = bracketStatus(cfg, res);
        if (bs.needsReset && Math.random() < 0.5) {
          cfg = genResetFinal(cfg, res, "b1").cfg;
          const gf2 = cfg.sched.find((m) => m.id === "b1gf2");
          winSeries(res, gf2, Math.random() < 0.5 ? gf2.a.g[0] : gf2.b.g[0]);
          [bs] = bracketStatus(cfg, res);
        }
        // structure: real distinct sides, unique ids, courts in range, staffed
        const ids = cfg.sched.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const m of cfg.sched) {
          expect(m.a.g[0]).toBeTruthy();
          expect(m.b.g[0]).toBeTruthy();
          expect(m.a.g[0]).not.toBe(m.b.g[0]);
          expect(m.ct).toBeGreaterThanOrEqual(1);
          expect(m.ct).toBeLessThanOrEqual(3);
          expect(m.ref).toBeTruthy(); // every bracket match staffed (N ≥ 3)
          expect([m.a.g[0], m.b.g[0]]).not.toContain(m.ref);
        }
        // losses: champion ≤1, everyone else exactly 2 (1 for the runner-up
        // when the bracket stands without the deciding game)
        const losses = new Map(groups.map((g) => [g.id, 0]));
        for (const m of cfg.sched) {
          const s = seriesScore(m, res);
          losses.set(s.aW > s.bW ? m.b.g[0] : m.a.g[0],
            (losses.get(s.aW > s.bW ? m.b.g[0] : m.a.g[0]) || 0) + 1);
        }
        expect(bs.champion).toBeTruthy();
        expect(losses.get(bs.champion)).toBeLessThanOrEqual(1);
        const standsWithoutReset = bs.gfDone && bs.gfWonByLB && !cfg.sched.some((m) => m.id === "b1gf2");
        for (const g of groups) {
          if (g.id === bs.champion) continue;
          if (standsWithoutReset && g.id === bs.runnerUp)
            expect(losses.get(g.id)).toBe(1);
          else expect(losses.get(g.id)).toBe(2);
        }
        // placements: every seed exactly once, champion then runner-up first
        const places = calcPlacements(cfg, res, eventBrackets(cfg)[0]).map((p) => p.id);
        expect(places).toHaveLength(N);
        expect(new Set(places).size).toBe(N);
        expect(places[0]).toBe(bs.champion);
        expect(places[1]).toBe(bs.runnerUp);
      }
    }
  });

  it("two brackets run independently with no cross-contamination", () => {
    const groups = Array.from({ length: 9 }, (_, i) => ({ id: "t" + i, name: "T" + i, players: [] }));
    const b1 = ["t0", "t1", "t2", "t3", "t4"], b2 = ["t5", "t6", "t7", "t8"];
    const res = {};
    let cfg = startPlayoffs(
      baseCfg({ format: "teams", groups, courts: 4, stage: "pool", seeds: [], po: {} }),
      res, { brackets: [b1, b2], po: {} }
    ).cfg;
    expect(cfg.sched.some((m) => m.lbl.startsWith("A · "))).toBe(true);
    expect(cfg.sched.some((m) => m.lbl.startsWith("B · "))).toBe(true);
    let guard = 0;
    while (guard++ < 80) {
      for (const m of cfg.sched.filter((m) => m.br && !matchDone(m, res)))
        winSeries(res, m, Math.random() < 0.5 ? m.a.g[0] : m.b.g[0]);
      const adv = advanceBracket(cfg, res);
      if (adv.error) break;
      cfg = adv.cfg;
    }
    for (const st of bracketStatus(cfg, res)) {
      if (st.needsReset) {
        cfg = genResetFinal(cfg, res, st.pfx).cfg;
        const gf2 = cfg.sched.find((m) => m.id === st.pfx + "gf2");
        winSeries(res, gf2, gf2.a.g[0]);
      }
    }
    const statuses = bracketStatus(cfg, res);
    expect(statuses).toHaveLength(2);
    expect(b1).toContain(statuses[0].champion);
    expect(b2).toContain(statuses[1].champion);
    for (const m of cfg.sched) {
      const home = b1.includes(m.a.g[0]) ? b1 : b2;
      expect(home).toContain(m.b.g[0]);
      if (m.ref) expect(home).toContain(m.ref); // refs never cross brackets
    }
    const bks = eventBrackets(cfg);
    expect(calcPlacements(cfg, res, bks[0]).map((p) => p.id).sort()).toEqual([...b1].sort());
    expect(calcPlacements(cfg, res, bks[1]).map((p) => p.id).sort()).toEqual([...b2].sort());
  });

  it("legacy single-bracket events (cfg.seeds, unprefixed ids) still resolve", () => {
    const groups = seeds4.map((id) => ({ id, name: id.toUpperCase(), players: [] }));
    let cfg = baseCfg({
      format: "teams", groups, courts: 2, stage: "playoff",
      seeds: [...seeds4], po: { g12: 21, g3: 15 },
    });
    delete cfg.brackets;
    const res = {};
    let adv = advanceBracket(cfg, res);
    expect(adv.error).toBeUndefined();
    cfg = adv.cfg;
    expect(cfg.sched.map((m) => m.id).sort()).toEqual(["w1s1", "w1s2"]); // no prefix
    let guard = 0;
    while (guard++ < 30) {
      for (const m of cfg.sched.filter((m) => m.br && !matchDone(m, res)))
        winSeries(res, m, m.a.g[0]);
      const a2 = advanceBracket(cfg, res);
      if (a2.error) break;
      cfg = a2.cfg;
    }
    const [bs] = bracketStatus(cfg, res);
    expect(bs.champion).toBeTruthy();
    expect(calcPlacements(cfg, res, eventBrackets(cfg)[0])).toHaveLength(4);
  });

  it("startPlayoffs rejects undersized brackets and unknown ids", () => {
    const cfg = poCfg();
    expect(startPlayoffs(cfg, {}, { brackets: [["t1"]], po: {} }).error).toBeTruthy();
    expect(startPlayoffs(cfg, {}, { brackets: [["t1", "t1", "ghost"]], po: {} }).error).toBeTruthy();
    expect(startPlayoffs(cfg, {}, { brackets: [seeds4, ["t9"]], po: {} }).error).toBeTruthy();
    expect(startPlayoffs(cfg, {}, { brackets: [], po: {} }).error).toBeTruthy();
  });
});

/* ---------------- ref assignments ---------------- */
describe("ref assignments", () => {
  it("pool play: ref from same pool, never a participant, duty balanced", () => {
    const cfg = genPoolPlay(baseCfg({ format: "teams", groups: mkTeams(4), pools: 1, poolGames: 1, courts: 2 }));
    const counts = {};
    for (const m of cfg.sched) {
      expect(m.ref).toBeTruthy();
      expect([m.a.g[0], m.b.g[0]]).not.toContain(m.ref);
      counts[m.ref] = (counts[m.ref] || 0) + 1;
    }
    const vals = Object.values(counts);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });

  it("pool play: the bye team refs, and played-twice matchups share one ref", () => {
    const cfg3 = genPoolPlay(baseCfg({ format: "teams", groups: mkTeams(3), pools: 1, poolGames: 1, courts: 2 }));
    for (const m of cfg3.sched) {
      expect(m.ref).toBe(cfg3.byes[m.rd][0]); // odd pool: the resting team has the whistle
    }
    const cfg2x = genPoolPlay(baseCfg({ format: "teams", groups: mkTeams(4), pools: 1, poolGames: 2, courts: 2 }));
    const byPair = new Map();
    for (const m of cfg2x.sched) {
      const k = pk(m.a.g[0], m.b.g[0]);
      byPair.set(k, [...(byPair.get(k) || []), m.ref]);
    }
    for (const [, refs] of byPair) {
      expect(refs).toHaveLength(2);
      expect(refs[0]).toBe(refs[1]);
    }
  });

  it("pool play: no team refs two matches in the same round; pools never share refs", () => {
    const five = genPoolPlay(baseCfg({ format: "teams", groups: mkTeams(5), pools: 1, courts: 4 }));
    for (let rd = 1; rd <= five.rds; rd++) {
      const refs = five.sched.filter((m) => m.rd === rd).map((m) => m.ref).filter(Boolean);
      expect(new Set(refs).size).toBe(refs.length);
    }
    const groups = mkTeams(8, true);
    const two = genPoolPlay(baseCfg({ format: "teams", groups, pools: 2, courts: 4 }));
    const poolOf = (gid) => groups.find((g) => g.id === gid).pool;
    for (const m of two.sched) {
      expect(m.ref).toBeTruthy();
      expect(poolOf(m.ref)).toBe(m.pl);
    }
  });

  it("bracket round 1: bye teams ref, worst seed first, top seed passes when possible", () => {
    const groups = Array.from({ length: 6 }, (_, i) => ({ id: "t" + i, name: "T" + i, players: [] }));
    const cfg = startPlayoffs(
      baseCfg({ format: "teams", groups, courts: 3, stage: "pool", seeds: [], po: {} }),
      {}, { brackets: [groups.map((g) => g.id)], po: {} }
    ).cfg;
    // seeds t0,t1 have byes; the two real matches get t1 first, t0 only as last resort
    expect(cfg.sched.map((m) => m.ref).sort()).toEqual(["t0", "t1"]);
    expect(cfg.sched[0].ref).toBe("t1");
  });

  it("reffing is best-effort: matches still post when nobody is free", () => {
    // 2-team bracket: no third team exists, ever
    const groups = [{ id: "x", name: "X", players: [] }, { id: "y", name: "Y", players: [] }];
    const res = {};
    let cfg = startPlayoffs(
      baseCfg({ format: "teams", groups, courts: 1, stage: "pool", seeds: [], po: {} }),
      res, { brackets: [["x", "y"]], po: {} }
    ).cfg;
    expect(cfg.sched).toHaveLength(1);
    expect(cfg.sched[0].ref).toBeUndefined(); // no whistle, no problem
    winSeries(res, cfg.sched[0], "x");
    cfg = advanceBracket(cfg, res).cfg; // 2-team double elim: gf is the rematch
    const gf = cfg.sched.find((m) => m.id === "b1gf");
    expect(gf).toBeTruthy();
    expect(gf.ref).toBeUndefined();
    winSeries(res, gf, "x");
    expect(bracketStatus(cfg, res)[0].champion).toBe("x");
    expect(calcPlacements(cfg, res, eventBrackets(cfg)[0]).map((p) => p.id)).toEqual(["x", "y"]);
    // 2-team pool: same story
    const pool = genPoolPlay(baseCfg({ format: "teams", groups, pools: 1, courts: 1 }));
    expect(pool.sched).toHaveLength(1);
    expect(pool.sched[0].ref).toBeUndefined();
  });
});
