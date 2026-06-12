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
