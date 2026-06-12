/* =====================================================================
   SIDEOUT store — every read/write the UI needs, backed by Firestore.

   Data model:
     events/{CODE}                   the cfg doc (see engine.js for shape)
     events/{CODE}/regs/{autoId}     { name, extra, ts }
     events/{CODE}/results/{matchId} { a, b, ts }

   Conventions (documented, not enforced):
   - The cfg doc is single-writer: only the director's device writes it
     (round generation, roster lock, IN/OUT toggles, walk-ups, status).
   - Results are one doc per match id; writing again is a correction,
     deleting is clear-result. Anyone may write — honor system.
   - Regs are deduped client-side by lowercase name, latest ts wins.
   ===================================================================== */

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, writeBatch,
} from "firebase/firestore";
import { db } from "./firebase.js";
import { newCode } from "./engine.js";

const evDoc = (code) => doc(db, "events", code);
const regsCol = (code) => collection(db, "events", code, "regs");
const resultsCol = (code) => collection(db, "events", code, "results");

// Older event docs predate the playoff/division fields; fill the defaults
// so the UI and engine can rely on them. Events that started a playoff
// before multi-bracket support keep working via cfg.seeds (the engine
// normalizes that to one bracket with unprefixed match ids).
const normalizeCfg = (d) => ({
  stage: "", pools: 1, poolGames: 1, seeds: [], brackets: [],
  po: { g12: 21, g3: 15 }, casual: false,
  ...d,
});

/* ---------------------- events ---------------------- */
export async function loadEvent(code) {
  const snap = await getDoc(evDoc(code));
  return snap.exists() ? normalizeCfg(snap.data()) : null;
}

// Picks an unused 4-letter code, writes the cfg doc, returns the full cfg.
export async function createEvent(cfg) {
  let code = newCode();
  for (let i = 0; i < 8; i++) {
    if (!(await getDoc(evDoc(code))).exists()) break;
    code = newCode();
  }
  const full = { ...cfg, code, created: Date.now() };
  await setDoc(evDoc(code), full);
  return full;
}

export async function saveCfg(code, cfg) {
  await setDoc(evDoc(code), cfg);
}

export function subscribeEvent(code, onData, onError) {
  return onSnapshot(
    evDoc(code),
    (snap) => onData(snap.exists() ? normalizeCfg(snap.data()) : null),
    onError
  );
}

export async function fetchRecents() {
  const q = query(collection(db, "events"), orderBy("created", "desc"), limit(8));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ code: d.id, name: d.data().name || "?", created: d.data().created || 0 }));
}

// Removes the event and its subcollections (regs, results, live) in batches.
export async function deleteEvent(code) {
  const [regSnap, resSnap, liveSnap] = await Promise.all([
    getDocs(regsCol(code)), getDocs(resultsCol(code)),
    getDocs(collection(db, "events", code, "live")).catch(() => ({ docs: [] })),
  ]);
  const refs = [
    ...regSnap.docs.map((d) => d.ref),
    ...resSnap.docs.map((d) => d.ref),
    ...liveSnap.docs.map((d) => d.ref),
    evDoc(code),
  ];
  while (refs.length) {
    const batch = writeBatch(db);
    for (const ref of refs.splice(0, 450)) batch.delete(ref);
    await batch.commit();
  }
}

/* ---------------------- registrations ---------------------- */
export async function register(code, name, extra, lvl, skill) {
  await addDoc(regsCol(code), {
    name, extra: extra || "", ts: Date.now(),
    ...(lvl ? { lvl } : {}),
    ...(skill ? { skill } : {}),
  });
}

export async function removeReg(code, regId) {
  await deleteDoc(doc(regsCol(code), regId));
}

export function subscribeRegs(code, onData, onError) {
  return onSnapshot(
    regsCol(code),
    (snap) => {
      const seen = new Map(); // dedupe by lowercase name, latest ts wins
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0))
        .forEach((r) => seen.set((r.name || "").toLowerCase(), r));
      onData([...seen.values()]);
    },
    onError
  );
}

/* ---------------------- results ---------------------- */
export async function saveResult(code, mid, a, b) {
  await setDoc(doc(resultsCol(code), mid), { a, b, ts: Date.now() });
}

export async function clearResult(code, mid) {
  await deleteDoc(doc(resultsCol(code), mid));
}

export function subscribeResults(code, onData, onError) {
  return onSnapshot(
    resultsCol(code),
    (snap) => {
      const res = {};
      for (const d of snap.docs) res[d.id] = d.data();
      onData(res);
    },
    onError
  );
}

/* ---------------------- live scores (scoreboards) ---------------------- */
// One doc per in-progress match: { a, b, g, ts }. Written best-effort from
// the score modal on every tap; phones never subscribe — only scoreboard
// readers do (see scoreboard/brain.mjs). Callers swallow failures: until
// the live block is in the published rules these writes just bounce.
const liveCol = (code) => collection(db, "events", code, "live");

export async function setLiveScore(code, mid, game, a, b) {
  await setDoc(doc(liveCol(code), mid), { a, b, g: game, ts: Date.now() });
}

export async function clearLiveScore(code, mid) {
  await deleteDoc(doc(liveCol(code), mid));
}

export function subscribeLive(code, onData, onError) {
  return onSnapshot(
    liveCol(code),
    (snap) => {
      const live = {};
      for (const d of snap.docs) live[d.id] = d.data();
      onData(live);
    },
    onError
  );
}

/* ---------------------- device-local (this phone only) ---------------------- */
const lsKey = (code, what) => `sideout:${code}:${what}`;
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } };

export const getMe = (code) => lsGet(lsKey(code, "me"));
export const setMe = (code, name) => lsSet(lsKey(code, "me"), name);
export const clearMe = (code) => lsDel(lsKey(code, "me"));
export const getPin = (code) => lsGet(lsKey(code, "apin"));
export const setPin = (code, pin) => lsSet(lsKey(code, "apin"), pin);
