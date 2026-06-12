/* One-off connectivity probe: verifies the pasted web config and reports
   whether the Firestore rules are published. Exercises the real store
   layer end-to-end with a throwaway event ZZZZ, then cleans it up. */
import * as store from "../src/store.js";

const cfg = {
  v: 1, code: "ZZZZ", name: "Probe — delete me", format: "mix",
  teamSize: 2, courts: 1, pointsTo: 21, pin: "0000",
  status: "signup", created: Date.now(),
  roster: [], groups: null, sched: [], rds: 0, mseq: 0,
  byes: {}, sit: {}, inact: [], sat: {},
};

const timeout = setTimeout(() => { console.log("RESULT: TIMEOUT — network to Firestore likely blocked from this environment"); process.exit(2); }, 25000);

try {
  const existing = await store.loadEvent("ZZZZ");
  console.log("read ok — events/ZZZZ:", existing ? "exists (leftover?)" : "absent");
  try {
    await store.saveCfg("ZZZZ", cfg);
    console.log("write ok — valid event doc accepted");
    await store.saveResult("ZZZZ", "m1", 21, 15);
    console.log("result write ok");
    await store.deleteEvent("ZZZZ");
    console.log("cleanup ok — probe event deleted");
    const gone = await store.loadEvent("ZZZZ");
    console.log("RESULT: FULL PASS — config valid, rules published and permitting reads/writes", gone ? "(but doc still present?!)" : "");
  } catch (e) {
    console.log("write failed:", e.code || e.message);
    console.log(e.code === "permission-denied"
      ? "RESULT: READS OK, WRITES DENIED — rules not pasted yet (or deny-all default)"
      : "RESULT: WRITE ERROR — see above");
  }
} catch (e) {
  console.log("read failed:", e.code || e.message);
  console.log(e.code === "permission-denied"
    ? "RESULT: CONFIG VALID but rules deny reads — firestore.rules not pasted yet"
    : "RESULT: CONNECTION/CONFIG ERROR — see above");
}
clearTimeout(timeout);
process.exit(0);
