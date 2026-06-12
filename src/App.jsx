import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* =====================================================================
   SIDEOUT — volleyball tournament day engine
   Formats: fixed-team round robin · rotating pairs (4s) · pickup mix
   Multi-phone sync via Firestore snapshots (see store.js).
   ===================================================================== */

import {
  uid, nameOf, groupOf, groupLabel, sideLabel, sidePlayerIds,
  genPoolPlay, genPairsRound, genMixRound,
  calcStandings, buildPairs, buildTeams,
  matchDone, matchGames, seriesScore, getGameTarget,
  seedFromStandings, startPlayoffs, advanceBracket, genResetFinal,
  bracketStatus, calcPlacements,
} from "./engine.js";
import * as store from "./store.js";
import { configReady } from "./firebase.js";

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
// One game at a time; Bo3 bracket matches get game tabs (G1/G2/G3).
function ScoreModal({ cfg, match, res, onSaveGame, onClearGame, onLive, onClose, canClear }) {
  const bo = match.br ? match.bo || 1 : 1;
  const games = matchGames(match, res);
  const series = match.br ? seriesScore(match, res) : null;
  const firstOpen = series && series.done ? games.length - 1 : games.length;
  const [gi, setGi] = useState(Math.max(0, Math.min(bo - 1, firstOpen)));
  const existing = match.br ? res[`${match.id}g${gi + 1}`] : res[match.id];
  const [a, setA] = useState(existing ? existing.a : 0);
  const [b, setB] = useState(existing ? existing.b : 0);
  const target = getGameTarget(cfg, match, gi);
  const pickGame = (i) => {
    setGi(i);
    const r = res[`${match.id}g${i + 1}`];
    setA(r ? r.a : 0); setB(r ? r.b : 0);
  };
  // every tap also feeds the live-scoreboard doc (best-effort, silent)
  const tapA = (v) => { setA(v); onLive && onLive(gi, v, b); };
  const tapB = (v) => { setB(v); onLive && onLive(gi, a, v); };
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
      <button className="pressable" onClick={() => set(target)}
        style={{ marginTop: 8, fontSize: 13, fontWeight: 800, padding: "6px 10px", border: `2px solid ${C.ink}`, borderRadius: 8, background: C.accentSoft, boxShadow: `2px 2px 0 ${C.ink}` }}>
        set {target}
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
          {match.lbl ? `${match.lbl} · Court ${match.ct}` : `Round ${match.rd} · Court ${match.ct}`} · game to {target}
        </Eyebrow>
        {bo > 1 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "8px 0 2px" }}>
            {Array.from({ length: bo }, (_, i) => {
              const played = !!res[`${match.id}g${i + 1}`];
              return (
                <button key={i} className="pressable" onClick={() => pickGame(i)} style={{
                  padding: "7px 14px", borderRadius: 8, border: `2px solid ${C.ink}`,
                  fontWeight: 800, fontSize: 13, fontFamily: MONO,
                  background: gi === i ? C.ink : played ? C.greenSoft : "#fff",
                  color: gi === i ? C.paper : C.ink,
                  boxShadow: `2px 2px 0 ${C.ink}`,
                }}>G{i + 1}</button>
              );
            })}
          </div>
        )}
        {series && (
          <div style={{ textAlign: "center", fontFamily: MONO, fontSize: 12.5, color: C.dim, marginTop: 4 }}>
            series {series.aW}–{series.bW}{series.done ? " · decided" : ` · first to ${series.need}`}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "10px 0 6px" }}>
          <Pad val={a} set={tapA} label={sideLabel(cfg, match.a)} />
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, paddingTop: 56, color: C.dim }}>–</div>
          <Pad val={b} set={tapB} label={sideLabel(cfg, match.b)} />
        </div>
        {a === b && (a > 0 || b > 0) && (
          <div style={{ color: "#B3261E", fontWeight: 700, fontSize: 13.5, textAlign: "center", marginBottom: 6 }}>
            No ties in volleyball — somebody won this one.
          </div>
        )}
        {match.br && a !== b && (a > 0 || b > 0) && Math.abs(a - b) < 2 && (
          <div style={{ color: C.gold, fontWeight: 700, fontSize: 13.5, textAlign: "center", marginBottom: 6 }}>
            Playoff games are win-by-two — saving anyway is your call.
          </div>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Btn kind="ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
          <Btn kind="green" style={{ flex: 2 }} disabled={a === b}
            onClick={() => onSaveGame(gi, a, b)}>
            {existing ? "Update score" : bo > 1 ? `Save game ${gi + 1}` : "Save final score"}
          </Btn>
        </div>
        {existing && canClear && (
          <div style={{ marginTop: 10, textAlign: "center" }}>
            <Btn kind="danger" small onClick={() => onClearGame(gi)}>{bo > 1 ? `Clear game ${gi + 1}` : "Clear result"}</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------- match card ---------------------- */
// `result` for plain matches ({a,b}), `series` for bracket matches.
function MatchCard({ cfg, match, result, series, onTap, highlightIds }) {
  const isSeries = !!match.br;
  const done = isSeries ? series.done : !!result;
  const started = isSeries && series.games.length > 0;
  const aIds = sidePlayerIds(cfg, match.a);
  const bIds = sidePlayerIds(cfg, match.b);
  const mine = highlightIds && (aIds.some((x) => highlightIds.has(x)) || bIds.some((x) => highlightIds.has(x)));
  const aWin = done && (isSeries ? series.aW > series.bW : result.a > result.b);
  const Side = ({ side, score, games, win }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
      <div style={{
        fontWeight: win ? 800 : 600, fontSize: 16, lineHeight: 1.3,
        color: done && !win ? C.dim : C.ink, flex: 1,
      }}>
        {sideLabel(cfg, side)} {win && <span style={{ color: C.green }}>✓</span>}
      </div>
      {games != null && (
        <div style={{ fontFamily: MONO, fontSize: games.length > 1 ? 19 : 26, fontWeight: 700, color: win ? C.ink : C.dim, whiteSpace: "nowrap" }}>
          {games.join("  ")}
        </div>
      )}
      {score != null && (
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <CourtBadge n={match.ct} />
          {match.pl && (
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em", background: "#fff", color: C.ink, border: `2px solid ${C.ink}`, borderRadius: 7, padding: "2px 6px" }}>
              POOL {match.pl === 1 ? "A" : "B"}
            </span>
          )}
          {isSeries && match.bo > 1 && (
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em", color: C.dim }}>BO3</span>
          )}
        </div>
        {!done && (
          <span className="blink" style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: C.accent }}>
            {started ? `GAME ${series.games.length + 1} · TAP TO SCORE` : "TAP TO SCORE"}
          </span>
        )}
        {done && <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em", color: C.green }}>FINAL</span>}
      </div>
      {isSeries ? (
        <>
          <Side side={match.a} games={series.games.map((g) => g.a)} win={aWin} />
          <div style={{ borderTop: `1.5px dashed ${C.line}` }} />
          <Side side={match.b} games={series.games.map((g) => g.b)} win={done && !aWin} />
        </>
      ) : (
        <>
          <Side side={match.a} score={done ? result.a : null} win={aWin} />
          <div style={{ borderTop: `1.5px dashed ${C.line}` }} />
          <Side side={match.b} score={done ? result.b : null} win={done && !aWin} />
        </>
      )}
      {match.ref && !done && (
        <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim, marginTop: 6, letterSpacing: "0.04em" }}>
          REF · {groupLabel(cfg, match.ref)}
        </div>
      )}
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

// Live-connection dot: green while the snapshot listeners are healthy,
// gray (and blinking) on listener error or while the device is offline.
function ConnDot({ ok }) {
  return (
    <span className={ok ? "" : "blink"} title={ok ? "Live sync connected" : "Reconnecting…"}
      style={{
        width: 12, height: 12, borderRadius: 999, display: "inline-block",
        background: ok ? C.green : "#9AA7B5", border: `2px solid ${C.ink}`,
        alignSelf: "center", flexShrink: 0,
      }} />
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
  const [me, setMe] = useState("");
  const [adminOk, setAdminOk] = useState(false);
  const [tab, setTab] = useState("schedule");
  const [modal, setModal] = useState(null);
  const [connOk, setConnOk] = useState(true);

  // forms
  const [fName, setFName] = useState("");
  const [fFormat, setFFormat] = useState("pairs");
  const [fTeamSize, setFTeamSize] = useState(2);
  const [fCourts, setFCourts] = useState(2);
  const [fPoints, setFPoints] = useState(21);
  const [fPoolGames, setFPoolGames] = useState(1);
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
  const [setupPools, setSetupPools] = useState(1);
  const [setupPlan, setSetupPlan] = useState("pool"); // 'pool' | 'bracket'

  // playoff seeding editor (teams format)
  const [poMode, setPoMode] = useState(false);
  const [poSeeds, setPoSeeds] = useState([]);
  const [poSel, setPoSel] = useState(null);
  const [poG12, setPoG12] = useState(21);
  const [poG3, setPoG3] = useState(15);
  const [poConfirm, setPoConfirm] = useState(false);

  const leavingRef = useRef(false); // suppresses the deleted-event handler while we tear down ourselves

  const say = (m) => { setToast(m); };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  /* -------------------- landing data -------------------- */
  const loadRecents = useCallback(async () => {
    if (!configReady) return;
    try { setRecents(await store.fetchRecents()); }
    catch (e) { console.error("recents failed", e); }
  }, []);
  useEffect(() => { loadRecents(); }, [loadRecents]);

  const leave = useCallback(() => {
    leavingRef.current = true;
    setView("landing"); setCode(""); setCfg(null); setRegs([]); setRes({});
    setMe(""); setAdminOk(false); setSetupMode(false);
    setPoMode(false); setPoConfirm(false);
    setJoinInput(""); setPinInput(""); setConnOk(true); loadRecents();
  }, [loadRecents]);

  /* -------------------- realtime subscriptions -------------------- */
  // cfg doc: subscribed for the whole stay in the event
  useEffect(() => {
    if (view !== "event" || !code) return undefined;
    leavingRef.current = false;
    const unsub = store.subscribeEvent(code,
      (data) => {
        if (!data) {
          if (!leavingRef.current) { setToast("This event was deleted."); leave(); }
          return;
        }
        setCfg(data); setConnOk(true);
      },
      (e) => { console.error("cfg listener", e); setConnOk(false); });
    return unsub;
  }, [view, code, leave]);

  // regs: only needed while signup is open
  const status = cfg ? cfg.status : null;
  useEffect(() => {
    if (view !== "event" || !code || status !== "signup") return undefined;
    const unsub = store.subscribeRegs(code,
      (list) => { setRegs(list); setConnOk(true); },
      (e) => { console.error("regs listener", e); setConnOk(false); });
    return unsub;
  }, [view, code, status]);

  // results: only needed once live (and after, for final standings)
  useEffect(() => {
    if (view !== "event" || !code || !status || status === "signup") return undefined;
    const unsub = store.subscribeResults(code,
      (map) => { setRes(map); setConnOk(true); },
      (e) => { console.error("results listener", e); setConnOk(false); });
    return unsub;
  }, [view, code, status]);

  useEffect(() => {
    const off = () => setConnOk(false);
    const on = () => setConnOk(true); // snapshots re-fire on reconnect
    window.addEventListener("offline", off);
    window.addEventListener("online", on);
    return () => { window.removeEventListener("offline", off); window.removeEventListener("online", on); };
  }, []);

  /* -------------------- join / create -------------------- */
  const joinEvent = async (c) => {
    const cc = (c || "").toUpperCase().trim();
    if (cc.length !== 4) { say("Codes are 4 letters."); return; }
    setBusy(true);
    let loaded = null;
    try { loaded = await store.loadEvent(cc); }
    catch (e) { console.error(e); setBusy(false); say("Couldn't reach the server — try again."); return; }
    if (!loaded) { setBusy(false); say(`No event found with code ${cc}.`); return; }
    setCode(cc); setCfg(loaded); setRegs([]); setRes({});
    const savedMe = store.getMe(cc);
    setMe(savedMe || "");
    const savedPin = store.getPin(cc);
    setAdminOk(!!savedPin && savedPin === loaded.pin);
    setTab("schedule"); setSetupMode(false); setPoMode(false); setModal(null); setConfirmDel(false);
    setView("event");
    setBusy(false);
  };

  const createEvent = async () => {
    if (!fName.trim()) { say("Give the event a name."); return; }
    if (!/^\d{4}$/.test(fPin)) { say("Pick a 4-digit director PIN."); return; }
    setBusy(true);
    try {
      const full = await store.createEvent({
        v: 2, name: fName.trim(), format: fFormat,
        teamSize: fFormat === "pairs" ? 2 : fTeamSize,
        courts: fCourts, pointsTo: fPoints, pin: fPin,
        status: "signup",
        roster: [], groups: null, sched: [], rds: 0, mseq: 0,
        byes: {}, sit: {}, inact: [], sat: {},
        stage: "", pools: 1,
        poolGames: fFormat === "teams" ? fPoolGames : 1,
        seeds: [], po: { g12: 21, g3: 15 },
      });
      store.setPin(full.code, fPin);
      setCode(full.code); setCfg(full); setRegs([]); setRes({});
      setMe(""); setAdminOk(true); setSetupMode(false);
      setTab("schedule"); setModal(null); setConfirmDel(false);
      setView("event");
      say(`Event created — code ${full.code}`);
    } catch (e) {
      console.error(e);
      say("Couldn't create the event — check connection and retry.");
    }
    setBusy(false);
  };

  /* -------------------- signup -------------------- */
  const register = () => {
    const nm = regName.trim();
    if (!nm) { say("Enter a name."); return; }
    if (regs.some((r) => r.name.toLowerCase() === nm.toLowerCase())) {
      say("That name's taken — add a last initial."); return;
    }
    store.register(code, nm, regExtra.trim())
      .catch((e) => { console.error(e); say("Couldn't save — check connection and retry."); });
    setRegName(""); setRegExtra("");
    say(`${nm} is in. 🏐`);
    if (!me) { setMe(nm); store.setMe(code, nm); }
  };

  const removeReg = (r) => {
    store.removeReg(code, r.id)
      .catch((e) => { console.error(e); say("Couldn't remove — check connection."); });
  };

  // director adds a player on someone's behalf (no phone needed)
  const directorAdd = () => {
    const nm = walkName.trim();
    if (!nm) { say("Enter a name."); return; }
    if (regs.some((r) => r.name.toLowerCase() === nm.toLowerCase())) {
      say("That name's already on the roster."); return;
    }
    store.register(code, nm, walkExtra.trim())
      .catch((e) => { console.error(e); say("Couldn't save — check connection and retry."); });
    setWalkName(""); setWalkExtra("");
    say(`${nm} added to the roster.`);
  };

  const unlockAdmin = () => {
    if (pinInput === cfg.pin) {
      setAdminOk(true); setPinInput("");
      store.setPin(code, cfg.pin);
      say("Director controls unlocked.");
    } else say("Wrong PIN.");
  };

  /* -------------------- cfg writes (director device only) -------------------- */
  // Optimistic: state updates immediately, the snapshot confirms, errors toast.
  const pushCfg = (next) => {
    setCfg(next);
    store.saveCfg(code, next)
      .catch((e) => { console.error(e); say("Couldn't sync that change — check connection."); });
  };

  /* -------------------- setup → start -------------------- */
  const startSetup = () => {
    const roster = regs.map((r) => ({ id: uid(), name: r.name }));
    if (cfg.format === "mix") {
      if (roster.length < 4) { say("Need at least 4 players."); return; }
      const live = { ...cfg, roster, status: "live", sat: Object.fromEntries(roster.map((r) => [r.id, 0])) };
      pushCfg(live);
      say("Event is live. Generate round 1 from Director.");
      setTab("admin");
      return;
    }
    const groups = cfg.format === "pairs"
      ? buildPairs(roster, regs)
      : buildTeams(roster, regs, cfg.teamSize);
    setSetupRoster(roster); setSetupGroups(groups); setSel(null);
    setSetupPools(1); setSetupPlan("pool");
    setSetupMode(true);
  };

  const setPoolCount = (n) => {
    setSetupPools(n);
    setSetupGroups(setupGroups.map((g, i) => ({ ...g, pool: n === 2 ? (i % 2) + 1 : 1 })));
  };
  const flipPool = (gid) => {
    setSetupGroups(setupGroups.map((g) => (g.id === gid ? { ...g, pool: g.pool === 2 ? 1 : 2 } : g)));
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

  const lockStart = () => {
    const full = setupGroups.filter((g) => g.players.length >= (cfg.format === "pairs" ? 2 : 1));
    const benched = setupGroups.filter((g) => !full.includes(g));
    if (full.length < 2) { say("Need at least 2 complete " + (cfg.format === "pairs" ? "pairs." : "teams.")); return; }
    let live = {
      ...cfg, roster: setupRoster,
      groups: setupGroups,
      inact: benched.map((g) => g.id),
      status: "live",
    };
    if (cfg.format === "teams") {
      live = { ...live, groups: full, inact: [], stage: "pool", pools: setupPools };
      if (setupPlan === "pool") live = genPoolPlay(live);
      if (benched.length) say("Heads up: incomplete teams were dropped.");
    }
    pushCfg(live);
    setSetupMode(false); setTab("schedule");
    if (cfg.format === "pairs") { say("Live! Generate round 1 from Director."); setTab("admin"); }
    if (cfg.format === "teams" && setupPlan === "bracket") {
      say("Live! Seed the bracket from Director when you're ready."); setTab("admin");
    }
  };

  /* -------------------- live actions -------------------- */
  // Bracket matches store one result doc per game (id + 'g1'..'g3').
  const saveScore = (m, gi, a, b) => {
    const rid = m.br ? `${m.id}g${gi + 1}` : m.id;
    const prev = res[rid];
    setRes((cur) => ({ ...cur, [rid]: { a, b, ts: Date.now() } }));
    setModal(null);
    store.clearLiveScore(code, m.id).catch(() => {}); // scoreboard: game's over
    store.saveResult(code, rid, a, b)
      .catch((e) => {
        console.error(e);
        say("Couldn't save — check connection and retry.");
        setRes((cur) => {
          const c2 = { ...cur };
          if (prev) c2[rid] = prev; else delete c2[rid];
          return c2;
        });
      });
  };

  const clearResult = (m, gi) => {
    const rid = m.br ? `${m.id}g${gi + 1}` : m.id;
    setRes((cur) => { const c2 = { ...cur }; delete c2[rid]; return c2; });
    setModal(null);
    store.clearLiveScore(code, m.id).catch(() => {});
    store.clearResult(code, rid)
      .then(() => say("Result cleared."))
      .catch((e) => { console.error(e); say("Couldn't clear — check connection."); });
  };

  const nextRound = () => {
    const out = cfg.format === "pairs" ? genPairsRound(cfg) : genMixRound(cfg);
    if (out.error) { say(out.error); return; }
    pushCfg(out.cfg);
    setTab("schedule");
    say(`Round ${out.cfg.rds} is up.`);
  };

  const toggleActive = (id) => {
    const inact = (cfg.inact || []).includes(id)
      ? cfg.inact.filter((x) => x !== id)
      : [...(cfg.inact || []), id];
    pushCfg({ ...cfg, inact });
  };

  const addWalkupLive = () => {
    const nm = walkName.trim();
    if (!nm) return;
    if (cfg.roster.some((r) => r.name.toLowerCase() === nm.toLowerCase())) { say("Name's taken."); return; }
    const p = { id: uid(), name: nm };
    const maxSat = Math.max(0, ...Object.values(cfg.sat || {}));
    pushCfg({ ...cfg, roster: [...cfg.roster, p], sat: { ...(cfg.sat || {}), [p.id]: maxSat } });
    setWalkName(""); say(`${nm} added — they'll rotate in next round.`);
  };

  // director adds a complete pair mid-event (rotating pairs format)
  const addWalkupPair = () => {
    const n1 = walkName.trim(), n2 = walkName2.trim();
    if (!n1 || !n2) { say("Need both names."); return; }
    if (n1.toLowerCase() === n2.toLowerCase()) { say("Two different names."); return; }
    const taken = (n) => cfg.roster.some((r) => r.name.toLowerCase() === n.toLowerCase());
    if (taken(n1) || taken(n2)) { say("One of those names is already playing."); return; }
    const p1 = { id: uid(), name: n1 }, p2 = { id: uid(), name: n2 };
    const g = { id: uid(), name: "Pair " + ((cfg.groups || []).length + 1), players: [p1.id, p2.id] };
    pushCfg({ ...cfg, roster: [...cfg.roster, p1, p2], groups: [...(cfg.groups || []), g] });
    setWalkName(""); setWalkName2("");
    say(`${n1}/${n2} are in — they'll rotate into round ${(cfg.rds || 0) + 1}.`);
  };

  /* -------------------- playoffs (teams format) -------------------- */
  const openPlayoffSetup = () => {
    setPoSeeds(seedFromStandings(cfg, res));
    setPoG12((cfg.po && cfg.po.g12) || 21);
    setPoG3((cfg.po && cfg.po.g3) || 15);
    setPoSel(null); setPoConfirm(false); setWalkName(""); setWalkExtra("");
    setPoMode(true);
  };

  const poSwapOrSelect = (gid) => {
    if (poSel === gid) { setPoSel(null); return; }
    if (!poSel) { setPoSel(gid); return; }
    const i = poSeeds.indexOf(poSel), j = poSeeds.indexOf(gid);
    const next = [...poSeeds];
    next[i] = gid; next[j] = poSel;
    setPoSeeds(next); setPoSel(null);
  };

  const poDrop = (gid) => {
    setPoSeeds(poSeeds.filter((x) => x !== gid));
    if (poSel === gid) setPoSel(null);
  };

  // team moving down from another level: lands in the event roster and at
  // the bottom of the seed list, all in one cfg write
  const poAddTeam = () => {
    const nm = walkName.trim();
    if (!nm) { say("Enter a team name."); return; }
    if ((cfg.groups || []).some((g) => g.name.toLowerCase() === nm.toLowerCase())) {
      say("That team name is already here."); return;
    }
    const players = walkExtra.split(",").map((s) => s.trim()).filter(Boolean)
      .filter((n) => !cfg.roster.some((r) => r.name.toLowerCase() === n.toLowerCase()))
      .map((n) => ({ id: uid(), name: n }));
    const g = { id: uid(), name: nm, players: players.map((p) => p.id), ...(cfg.pools === 2 ? { pool: 1 } : {}) };
    pushCfg({ ...cfg, roster: [...cfg.roster, ...players], groups: [...(cfg.groups || []), g] });
    setPoSeeds((cur) => [...cur, g.id]);
    setWalkName(""); setWalkExtra("");
    say(`${nm} is in the bracket — seeded last, tap to move them up.`);
  };

  const confirmStartPlayoffs = () => {
    const out = startPlayoffs(cfg, res, { seeds: poSeeds, po: { g12: poG12, g3: poG3 } });
    if (out.error) { say(out.error); return; }
    pushCfg(out.cfg);
    setPoMode(false); setPoConfirm(false); setTab("schedule");
    say("Bracket is live. 🏆");
  };

  const doAdvanceBracket = () => {
    const out = advanceBracket(cfg, res);
    if (out.error) { say(out.error); return; }
    pushCfg(out.cfg); setTab("schedule");
    say("New bracket matches are up.");
  };

  const doResetFinal = () => {
    const out = genResetFinal(cfg, res);
    if (out.error) { say(out.error); return; }
    pushCfg(out.cfg); setTab("schedule");
    say("Deciding game is on the board.");
  };

  const endEvent = () => {
    pushCfg({ ...cfg, status: "done" });
    setTab("standings"); say("Final standings are posted. 🏆");
  };
  const reopenEvent = () => {
    pushCfg({ ...cfg, status: "live" });
    say("Scoring reopened.");
  };

  const deleteEvent = async () => {
    setBusy(true);
    leavingRef.current = true; // our own teardown — don't toast "deleted"
    try {
      await store.deleteEvent(code);
      say("Event deleted.");
      leave();
    } catch (e) {
      console.error(e);
      leavingRef.current = false;
      say("Couldn't delete — check connection and retry.");
    }
    setBusy(false);
  };

  const pickMe = (nm) => {
    setMe(nm); store.setMe(code, nm);
  };

  /* -------------------- derived -------------------- */
  const myIds = useMemo(() => {
    if (!cfg || !me) return new Set();
    const mine = cfg.roster.filter((r) => r.name.toLowerCase() === me.toLowerCase()).map((r) => r.id);
    return new Set(mine);
  }, [cfg, me]);

  const standings = useMemo(() => (cfg && cfg.status !== "signup" ? calcStandings(cfg, res) : []), [cfg, res]);
  const doneCount = cfg ? cfg.sched.filter((m) => matchDone(m, res)).length : 0;
  const bs = useMemo(
    () => (cfg && cfg.stage === "playoff" ? bracketStatus(cfg, res) : null),
    [cfg, res]
  );
  const placements = useMemo(
    () => (cfg && cfg.stage === "playoff" ? calcPlacements(cfg, res) : []),
    [cfg, res]
  );

  /* ==================== RENDER ==================== */

  /* ---------- landing ---------- */
  function renderLanding() {
    return (
      <Shell toast={toast}>
        <div style={{ margin: "26px 0 6px" }}><Logo /></div>
        <div style={{ color: C.dim, fontSize: 15, marginBottom: 26 }}>
          Sand &amp; grass volleyball — brackets of people, not paperwork.
        </div>
        {!configReady && (
          <Card style={{ marginBottom: 18, background: "#FFF8E6" }}>
            <Eyebrow style={{ marginBottom: 6 }}>Setup needed</Eyebrow>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              Firebase isn't wired up yet. Paste the web app config from the Firebase
              console into <span style={{ fontFamily: MONO }}>src/firebase.js</span> and redeploy.
            </div>
          </Card>
        )}
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
              <div key={r.code} onClick={() => joinEvent(r.code)} className="pressable"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px", borderBottom: `1.5px dashed ${C.line}`, cursor: "pointer" }}>
                <div style={{ fontWeight: 700 }}>{r.name}</div>
                <div style={{ fontFamily: MONO, fontWeight: 700, color: C.accent }}>{r.code}</div>
              </div>
            ))}
          </Card>
        )}
        <Btn kind="ink" style={{ width: "100%" }} onClick={() => setView("create")}>+ Create a new event</Btn>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 22, lineHeight: 1.5 }}>
          Heads up: events, rosters, and scores live in a shared public database — anyone
          with the app can see them. First names work great.
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
          <Eyebrow style={{ margin: "4px 0 8px", color: C.ink }}>{fFormat === "teams" ? "Pool games to" : "Game to"}</Eyebrow>
          <div style={{ marginBottom: 16 }}>
            <ChoiceRow value={fPoints} onChange={setFPoints}
              options={[{ v: 11, label: "11" }, { v: 15, label: "15" }, { v: 21, label: "21" }, { v: 25, label: "25" }]} />
          </div>
          {fFormat === "teams" && (
            <>
              <Eyebrow style={{ margin: "4px 0 8px", color: C.ink }}>Pool matchups played</Eyebrow>
              <div style={{ marginBottom: 16 }}>
                <ChoiceRow value={fPoolGames} onChange={setFPoolGames}
                  options={[{ v: 1, label: "Once" }, { v: 2, label: "Twice" }]} />
              </div>
            </>
          )}
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
              {cfg.status === "signup" ? "signup open"
                : cfg.status === "done" ? "final"
                : cfg.stage === "playoff" ? `playoffs · ${doneCount}/${cfg.sched.length} scored`
                : cfg.format === "teams" ? `pool play · ${doneCount}/${cfg.sched.length} scored`
                : `live · ${doneCount}/${cfg.sched.length} scored`}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0, alignItems: "center" }}>
          <ConnDot ok={connOk} />
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
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 2px", borderBottom: `1.5px dashed ${C.line}` }}>
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
        {cfg.format === "teams" && (
          <Card style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Pools</Eyebrow>
            <ChoiceRow value={setupPools} onChange={setPoolCount}
              options={[{ v: 1, label: "One pool" }, { v: 2, label: "Two pools" }]} />
            {setupPools === 2 && (
              <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
                Tap a team's pool tag to flip it between A and B.
              </div>
            )}
            <Eyebrow style={{ margin: "14px 0 8px" }}>Day plan</Eyebrow>
            <ChoiceRow value={setupPlan} onChange={setSetupPlan}
              options={[{ v: "pool", label: "Pool play → playoffs" }, { v: "bracket", label: "Straight to bracket" }]} />
            {setupPlan === "bracket" && (
              <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
                No pool schedule — you'll hand-seed the bracket from the Director tab.
                Handy for day-two divisions seeded off yesterday's results.
              </div>
            )}
          </Card>
        )}
        {setupGroups.map((g) => (
          <Card key={g.id} style={{ marginBottom: 12, padding: 12, borderLeft: g.players.length < want ? `6px solid ${C.gold}` : `2px solid ${C.ink}` }}>
            {cfg.format === "teams" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input value={g.name} onChange={(e) => renameGroup(g.id, e.target.value)}
                  style={{ fontWeight: 800, fontSize: 16, border: "none", background: "transparent", color: C.ink, flex: 1, minWidth: 0, padding: 0 }} />
                {setupPools === 2 && (
                  <button className="pressable" onClick={() => flipPool(g.id)} style={{
                    fontFamily: MONO, fontWeight: 700, fontSize: 12, letterSpacing: "0.06em",
                    background: g.pool === 2 ? C.ink : C.accent, color: "#fff",
                    border: `2px solid ${C.ink}`, borderRadius: 7, padding: "4px 8px",
                    boxShadow: `2px 2px 0 ${C.ink}`, flexShrink: 0,
                  }}>POOL {g.pool === 2 ? "B" : "A"}</button>
                )}
              </div>
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
          <div style={{ fontWeight: 800, fontSize: 18, marginTop: 6 }}>{cfg.format === "teams" ? "No matches yet" : "No rounds yet"}</div>
          <div style={{ color: C.dim, fontSize: 14.5, marginTop: 4 }}>
            {adminOk
              ? cfg.format === "teams" ? "Seed the bracket from the Director tab." : "Generate round 1 from the Director tab."
              : "The director hasn't posted anything yet."}
          </div>
        </Card>
      );
    }
    // per-court now/next strip so courts never sit idle waiting for word
    const upNext = [];
    if (cfg.status === "live") {
      for (let ct = 1; ct <= cfg.courts; ct++) {
        const q = cfg.sched.filter((m) => m.ct === ct && !matchDone(m, res));
        if (q.length) upNext.push({ ct, now: q[0], next: q[1] });
      }
    }
    const vsLine = (m) => `${sideLabel(cfg, m.a)} vs ${sideLabel(cfg, m.b)}`;
    // group pool matches by round, bracket matches by their stage label;
    // newest group on top (matches the old newest-round-first ordering)
    const groups = [];
    const byKey = new Map();
    cfg.sched.forEach((m, i) => {
      const key = m.lbl || `ROUND ${m.rd}`;
      if (!byKey.has(key)) {
        const g = { key, rd: m.lbl ? null : m.rd, order: i, ms: [] };
        byKey.set(key, g); groups.push(g);
      }
      byKey.get(key).ms.push(m);
    });
    groups.sort((x, y) => y.order - x.order);
    return (
      <div>
        {upNext.length > 0 && (
          <Card style={{ marginBottom: 16, padding: 12, background: "#FBF3E4" }}>
            <Eyebrow style={{ marginBottom: 8 }}>Up next by court</Eyebrow>
            {upNext.map(({ ct, now, next }) => (
              <div key={ct} style={{ display: "flex", gap: 10, padding: "7px 2px", borderBottom: `1.5px dashed ${C.line}`, alignItems: "baseline" }}>
                <CourtBadge n={ct} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.3 }}>
                    {vsLine(now)}
                    {now.ref && <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.dim }}> · ref {groupLabel(cfg, now.ref)}</span>}
                  </div>
                  {next && (
                    <div style={{ fontSize: 12.5, color: C.dim, marginTop: 2 }}>
                      then: {vsLine(next)}
                      {next.ref && <span style={{ fontFamily: MONO, fontSize: 11 }}> · ref {groupLabel(cfg, next.ref)}</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </Card>
        )}
        {groups.map((grp) => {
          const byes = grp.rd != null ? (cfg.byes || {})[grp.rd] || [] : [];
          const sit = grp.rd != null ? (cfg.sit || {})[grp.rd] || [] : [];
          return (
            <div key={grp.key} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 13, background: C.accent, color: "#fff", borderRadius: 8, padding: "4px 10px" }}>{grp.key}</div>
                <div style={{ flex: 1, borderTop: `2px solid ${C.line}` }} />
              </div>
              {grp.ms.map((m) => (
                <MatchCard key={m.id} cfg={cfg} match={m}
                  result={m.br ? null : res[m.id]}
                  series={m.br ? seriesScore(m, res) : null}
                  highlightIds={myIds}
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
    const table = (rows, title) => (
      <div key={title || "all"} style={{ marginBottom: 14 }}>
        {title && <Eyebrow style={{ margin: "0 0 8px" }}>{title}</Eyebrow>}
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", padding: "10px 14px", background: C.ink, color: C.paper, fontSize: 11.5, fontWeight: 800, letterSpacing: "0.1em" }}>
            <div style={{ width: 34 }}>#</div>
            <div style={{ flex: 1 }}>{fmtLabel.toUpperCase()}</div>
            <div style={{ width: 56, textAlign: "right" }}>W–L</div>
            <div style={{ width: 56, textAlign: "right" }}>DIFF</div>
          </div>
          {rows.map((s, i) => {
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
      </div>
    );
    const inPlayoffs = cfg.stage === "playoff";
    const poolTables = cfg.format === "teams" && cfg.pools === 2
      ? [
          table(standings.filter((s) => (groupOf(cfg, s.id) || {}).pool !== 2), "Pool A"),
          table(standings.filter((s) => (groupOf(cfg, s.id) || {}).pool === 2), "Pool B"),
        ]
      : [table(standings)];
    return (
      <div>
        {cfg.status === "done" && (
          <Card accent style={{ textAlign: "center", marginBottom: 14, background: C.greenSoft }}>
            <div style={{ fontWeight: 900, fontSize: 20 }}>🏆 Final standings</div>
          </Card>
        )}
        {inPlayoffs && placements.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <Eyebrow style={{ margin: "0 0 8px" }}>{cfg.status === "done" ? "Final placements" : "Bracket — live placements"}</Eyebrow>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              {placements.map((p, i) => (
                <div key={p.id} style={{
                  display: "flex", alignItems: "center", padding: "11px 14px",
                  borderBottom: `1.5px dashed ${C.line}`,
                  background: i === 0 && bs && bs.champion ? "#FFF8E6" : "#fff",
                }}>
                  <div style={{ width: 34, fontFamily: MONO, fontWeight: 700, color: i === 0 && bs && bs.champion ? C.gold : C.dim }}>{i + 1}</div>
                  <div style={{ flex: 1, fontWeight: 700, fontSize: 15.5 }}>{p.label}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>SEED {cfg.seeds.indexOf(p.id) + 1}</div>
                </div>
              ))}
            </Card>
            {cfg.status !== "done" && (
              <div style={{ fontSize: 12.5, color: C.dim, marginTop: 8 }}>Updates as bracket results land; final when the director ends the event.</div>
            )}
          </div>
        )}
        {inPlayoffs && <Eyebrow style={{ margin: "0 0 8px" }}>Pool play results</Eyebrow>}
        {poolTables}
        <div style={{ fontSize: 12.5, color: C.dim, marginTop: -4 }}>Ranked by wins, then point differential, then points for.</div>
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
    const pending = mine.filter((m) => !matchDone(m, res));
    const played = mine.filter((m) => matchDone(m, res)).reverse();
    let w = 0, l = 0, diff = 0;
    for (const m of mine) {
      const onA = sidePlayerIds(cfg, m.a).some((x) => myIds.has(x));
      for (const r of matchGames(m, res)) { // every completed game counts
        const my = onA ? r.a : r.b, their = onA ? r.b : r.a;
        my > their ? w++ : l++; diff += my - their;
      }
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
        <button onClick={() => { setMe(""); store.clearMe(code); }} style={{ border: "none", background: "none", color: C.dim, fontSize: 13, textDecoration: "underline", marginBottom: 12, cursor: "pointer", padding: 0 }}>Not you? Switch player</button>
        <Eyebrow style={{ margin: "4px 0 10px" }}>Up next</Eyebrow>
        {pending.length === 0 && <div style={{ color: C.dim, fontSize: 14.5, marginBottom: 14 }}>Nothing on the board — hydrate. 🧃</div>}
        {pending.map((m) => <MatchCard key={m.id} cfg={cfg} match={m} result={null} series={m.br ? seriesScore(m, res) : null} highlightIds={myIds} onTap={() => setModal(m)} />)}
        {played.length > 0 && <Eyebrow style={{ margin: "10px 0" }}>Played</Eyebrow>}
        {played.map((m) => <MatchCard key={m.id} cfg={cfg} match={m} result={m.br ? null : res[m.id]} series={m.br ? seriesScore(m, res) : null} highlightIds={myIds} onTap={() => setModal(m)} />)}
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
    const unscoredPool = cfg.format === "teams"
      ? cfg.sched.filter((m) => !m.br && !res[m.id]).length
      : 0;
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
        {cfg.format === "teams" && cfg.status === "live" && cfg.stage !== "playoff" && (
          <Card accent style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Playoffs</Eyebrow>
            <Btn kind="green" style={{ width: "100%" }} disabled={busy} onClick={openPlayoffSetup}>
              Set up playoffs →
            </Btn>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
              Seeds start from pool standings{cfg.pools === 2 ? " (cross-seeded A1, B1, A2, B2…)" : ""}.
              You can reorder, drop a team that moved up a level, or add one that moved down
              before the bracket locks.
              {unscoredPool > 0 ? ` ${unscoredPool} pool ${unscoredPool === 1 ? "match has" : "matches have"} no score yet.` : ""}
            </div>
          </Card>
        )}
        {cfg.format === "teams" && cfg.status === "live" && cfg.stage === "playoff" && (
          <Card accent style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Bracket</Eyebrow>
            <Btn kind="green" style={{ width: "100%" }} disabled={busy} onClick={doAdvanceBracket}>
              Advance bracket →
            </Btn>
            {bs && bs.needsReset && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
                  The losers-bracket team took the grand final. House rules decide:
                  play one deciding game, or end the event and let the win stand.
                </div>
                <Btn kind="ink" small style={{ width: "100%" }} onClick={doResetFinal}>
                  Generate deciding game
                </Btn>
              </div>
            )}
            {bs && bs.champion && !bs.needsReset && (
              <div style={{ fontSize: 13.5, color: C.dim, marginTop: 8 }}>
                Bracket champion: <b>{groupLabel(cfg, bs.champion)}</b> — end the event to post final standings.
              </div>
            )}
            {!(bs && (bs.champion || bs.needsReset)) && (
              <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
                Posts every newly-determined match — winners advance, first losses drop
                to the single-game losers bracket.
              </div>
            )}
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

  /* ---------- playoff seeding editor ---------- */
  function renderPlayoffSetup() {
    const unscoredPool = cfg.sched.filter((m) => !m.br && !res[m.id]).length;
    const dropped = (cfg.groups || []).filter((g) => !poSeeds.includes(g.id));
    return (
      <Shell toast={toast}>
        {renderHeader()}
        <Card accent style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 20 }}>Seed the bracket</div>
          <div style={{ fontSize: 13.5, color: C.dim, marginTop: 4 }}>
            Order comes from pool standings. Tap two teams to swap seeds, ✕ to pull a
            team from the bracket (moving up a level), or add a team coming down.
          </div>
        </Card>
        <Card style={{ marginBottom: 14, padding: 12 }}>
          {poSeeds.map((gid, i) => (
            <div key={gid} onClick={() => poSwapOrSelect(gid)} className="pressable" style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 8px",
              borderBottom: `1.5px dashed ${C.line}`, cursor: "pointer", borderRadius: 8,
              background: poSel === gid ? C.accentSoft : "transparent",
            }}>
              <div style={{ fontFamily: MONO, fontWeight: 700, width: 28, color: poSel === gid ? C.accent : C.dim }}>{i + 1}</div>
              <div style={{ flex: 1, fontWeight: 700 }}>{groupLabel(cfg, gid)}</div>
              {cfg.pools === 2 && (groupOf(cfg, gid) || {}).pool && (
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>POOL {(groupOf(cfg, gid) || {}).pool === 2 ? "B" : "A"}</span>
              )}
              <button onClick={(e) => { e.stopPropagation(); poDrop(gid); }}
                style={{ border: "none", background: "none", color: "#B3261E", fontWeight: 800, fontSize: 16, cursor: "pointer" }}>✕</button>
            </div>
          ))}
          {poSeeds.length === 0 && <div style={{ color: C.dim, fontSize: 14.5 }}>Nobody in the bracket — add teams below.</div>}
        </Card>
        {dropped.length > 0 && (
          <Card style={{ marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Out of the bracket</Eyebrow>
            {dropped.map((g) => (
              <div key={g.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 2px", borderBottom: `1.5px dashed ${C.line}` }}>
                <div style={{ fontWeight: 700, color: C.dim }}>{g.name}</div>
                <Btn kind="ghost" small onClick={() => setPoSeeds([...poSeeds, g.id])}>Re-add</Btn>
              </div>
            ))}
          </Card>
        )}
        <Card style={{ marginBottom: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Add a team — moved down from another level</Eyebrow>
          <input value={walkName} onChange={(e) => setWalkName(e.target.value)} placeholder="Team name"
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
          <input value={walkExtra} onChange={(e) => setWalkExtra(e.target.value)} placeholder="Players (optional, comma-separated)"
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `2px solid ${C.ink}`, borderRadius: 10, fontSize: 16, marginBottom: 8, background: "#fff", color: C.ink }} />
          <Btn kind="ink" small style={{ width: "100%" }} onClick={poAddTeam}>Add to bracket</Btn>
        </Card>
        <Card style={{ marginBottom: 14 }}>
          <Eyebrow style={{ marginBottom: 8 }}>Games 1–2 to</Eyebrow>
          <ChoiceRow value={poG12} onChange={setPoG12}
            options={[{ v: 15, label: "15" }, { v: 21, label: "21" }, { v: 25, label: "25" }]} />
          <Eyebrow style={{ margin: "12px 0 8px" }}>Game 3 &amp; decider to</Eyebrow>
          <ChoiceRow value={poG3} onChange={setPoG3}
            options={[{ v: 11, label: "11" }, { v: 15, label: "15" }, { v: 21, label: "21" }]} />
          <div style={{ fontSize: 13, color: C.dim, marginTop: 10 }}>
            Winners bracket and grand final are best of 3, win by two, no cap.
            Losers bracket is a single game to {poG12}.
          </div>
        </Card>
        {!poConfirm ? (
          <Btn kind="green" style={{ width: "100%" }} disabled={poSeeds.length < 2}
            onClick={() => (unscoredPool > 0 ? setPoConfirm(true) : confirmStartPlayoffs())}>
            Start playoffs ✓
          </Btn>
        ) : (
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#B3261E", marginBottom: 8, textAlign: "center" }}>
              {unscoredPool} pool {unscoredPool === 1 ? "match has" : "matches have"} no score — they won't count toward seeding.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn kind="ghost" style={{ flex: 1 }} onClick={() => setPoConfirm(false)}>Go back</Btn>
              <Btn kind="green" style={{ flex: 1 }} onClick={confirmStartPlayoffs}>Start anyway</Btn>
            </div>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Btn kind="ghost" small onClick={() => setPoMode(false)}>← Back</Btn>
        </div>
      </Shell>
    );
  }

  /* ---------- live shell with tabs ---------- */
  function renderEvent() {
    if (cfg.status === "signup" && setupMode) return renderSetup();
    if (cfg.status === "signup") return renderLobby();
    if (poMode && adminOk && cfg.status === "live" && cfg.format === "teams" && cfg.stage !== "playoff")
      return renderPlayoffSetup();
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
          <ScoreModal key={modal.id} cfg={cfg} match={modal} res={res}
            canClear={adminOk}
            onSaveGame={(gi, a, b) => saveScore(modal, gi, a, b)}
            onClearGame={(gi) => clearResult(modal, gi)}
            onLive={(gi, a, b) => store.setLiveScore(code, modal.id, gi + 1, a, b).catch(() => {})}
            onClose={() => setModal(null)} />
        )}
      </Shell>
    );
  }

  if (view === "create") return renderCreate();
  if (view === "event" && cfg) return renderEvent();
  return renderLanding();
}
