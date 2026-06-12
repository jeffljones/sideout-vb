# SIDEOUT — Migration Brief: Claude Artifact → Firebase

**For:** Claude Code session
**Repo contents at start:** this file + `sideout.jsx` (the working Claude-artifact version)
**Owner:** Jeff — runs rec sand/grass volleyball tournaments and pickup days in Florida

---

## 1. What this app is

SIDEOUT is a phone-first tournament day engine for recreational volleyball. One person (the director) creates an event and gets a 4-letter join code; players join from their phones, register, and anyone can enter scores. Three formats, all implemented and logic-tested in `sideout.jsx`:

1. **Fixed teams round robin** (2s–6s) — full schedule generated at lock-in via circle method, bye rotation for odd team counts.
2. **Rotating pairs** — players keep one partner all day; each round, pairs are combined into 4s matches (Pair A + Pair B vs Pair C + Pair D), with history-weighted grouping to minimize repeat teammates/opponents and fair bye rotation. Leftover 2 pairs play head-to-head 2v2.
3. **Pickup mix** — random teams every round, individual standings, sit-out fairness (most-benched players go in first), small-group fallback shrinks team size.

Context that should shape decisions: used courtside in direct Florida sun, sandy thumbs, on phones. Some venues are nudist resorts where **many players carry no phone at all** — the director proxy-registers them and any phone enters their scores. Everything is honor-system; there are no user accounts and there should not be any.

## 2. Why we're migrating

The artifact version uses Claude's `window.storage` API as its backend. That API only exists inside Claude artifacts. We want: a plain public URL anyone can open with zero sign-in, instant score sync instead of 20-second polling, and no dependency on artifact publishing (where unpublishing permanently deletes all data).

## 3. Target stack

- **Vite + React 18**, plain JavaScript (no TypeScript). Single-page app.
- **Firebase** (free Spark plan): **Firestore** for data, **Firebase Hosting** for the app. Firebase JS SDK v10+ modular imports.
- **GitHub** is the source of truth. Add a GitHub Action that runs `firebase deploy` on push to `main` (use `FirebaseExtended/action-hosting-deploy` or plain CLI with a `FIREBASE_TOKEN`/service-account secret — whichever is currently recommended).
- **PWA-lite:** `manifest.json` + icons + apple-touch meta so players can Add to Home Screen. **No service worker in v1** (scores need network anyway; don't risk stale-cache confusion).

**Execution environment: Claude Code on the web.** There is NO local Firebase CLI session available — never attempt `firebase login`, `firebase init`, or `firebase deploy` from this environment; interactive Google OAuth cannot work here. All deploys happen via GitHub Action. The Firebase project already exists (`sideout-vb`) with Firestore created (us-east1).

Jeff handles exactly three manual tasks in his browser; prompt him for each at the right moment:
1. **Web config:** Firebase console → ⚙️ Project settings → Your apps → Add app (Web) → register "SIDEOUT" → paste the `firebaseConfig` object into chat. Commit it to the repo — it is public-safe by design.
2. **Rules:** when `firestore.rules` is final, print it in full and have Jeff paste it at Firebase console → Firestore Database → Rules → Publish.
3. **Deploy secret:** Jeff creates a service account (console.cloud.google.com → IAM & Admin → Service Accounts → Create, name `github-deployer`, role **Firebase Hosting Admin**), adds a JSON key, and pastes the key contents into the GitHub repo as Actions secret `FIREBASE_SERVICE_ACCOUNT`. Give him these click-path instructions verbatim when you reach the deploy step.

## 4. What to keep verbatim vs. replace

**Keep (port unchanged — these are tested and correct):**
- All scheduling/standings logic: `genRoundRobin`, `genPairsRound`, `genMixRound`, `buildHist`, `calcStandings`, `buildPairs`, `buildTeams`, `shuffle`, `pk`, and the side/label helpers (`nameOf`, `groupOf`, `groupLabel`, `sideLabel`, `sideStatIds`, `sidePlayerIds`). Move them to `src/engine.js` and port the test harness ideas into `engine.test.js` (vitest) — the original assertions are described in comments at the top of the harness section.
- The full UI: every screen, component, color token, and interaction in `sideout.jsx` (landing, create, lobby, setup editor with tap-to-swap, live tabs Schedule/Standings/Me/Director, bottom-sheet score modal). The visual design (warm paper / ink navy / orange, hard borders, offset shadows, monospace scoreboard numerals) is intentional — do not restyle.
- The `cfg` object shape and all format semantics.

**Replace:**
- The storage layer (`sGet/sSet/sDel/sList`, key codecs `parseRegKey/parseDoneKey/parseIdxKey`) and the 20s polling `refresh()` loop. The key-encoding scheme (data packed into key names) existed only because artifact storage was list-only-cheap; **do not port it**. Use real Firestore documents.
- `window.storage` personal keys (`me`, `apin`) → **`localStorage`** (banned in artifacts, fine here): `sideout:CODE:me`, `sideout:CODE:apin`.

## 5. Firestore data model

```
events/{CODE}                  ← the cfg doc, minus regs/results
  name, format, teamSize, courts, pointsTo, pin,
  status: 'signup'|'live'|'done', created,
  roster: [{id,name}], groups: [{id,name,players:[]}] | null,
  sched: [{id,rd,ct,a,b}], rds, mseq,
  byes: {}, sit: {}, inact: [], sat: {}

events/{CODE}/regs/{autoId}    ← { name, extra, ts }
events/{CODE}/results/{matchId} ← { a, b, ts }
```

Notes:
- **CODE** is the 4-letter join code (generate from `ABCDEFGHJKMNPQRSTUVWXYZ`, check non-existence before create).
- The cfg doc keeps the **single-writer assumption**: only the director's device writes it (round generation, roster lock, active toggles, walk-ups, status). Keep that as a documented convention, not enforced.
- **Results:** one doc per match id. Writing again = correction (replaces the timestamp dance from the artifact). Deleting the doc = clear result. Anyone may write — honor system.
- **Regs:** one doc per registration; dedupe client-side by lowercase name (latest ts wins). Director "remove player" deletes the doc.
- **Landing page recents:** `query(collection('events'), orderBy('created','desc'), limit(8))` replaces the index keys.

## 6. Realtime sync

Replace polling with `onSnapshot`:
- On join: subscribe to `events/{CODE}` (cfg), and to `regs` while `status === 'signup'`, and to `results` while live/done. Unsubscribe on leave and when status transitions make a subscription irrelevant.
- Delete the 20s interval, the manual refresh button, and the "Synced 2:14 PM" footer. Replace with a small live-connection dot in the header (green when the snapshot listener is healthy, gray on error/offline).
- Keep optimistic local updates on score save; the snapshot will confirm.

## 7. Security rules (honor-system, shape-validated)

Keep `firestore.rules` in the repo as the source of truth, but it is **deployed by console paste** (Jeff's manual task #2 above), so keep it self-contained and print the final version clearly when done.

No auth. Rules should allow reads on `events/**`; allow `create` on event docs (validate: 4-letter id, required fields, `status == 'signup'`, string lengths sane); allow `update` on event docs (don't try to enforce the PIN — it's a UI-level gate); allow `create/delete` on regs (validate name ≤ 24 chars); allow `create/update/delete` on results (validate `a`/`b` are ints 0–99, doc id ≤ 12 chars). Cap string/array sizes generously to keep vandalism boring. Document clearly in the README: this is rec-league trust level — nothing sensitive goes in event names or player names; first names only.

## 8. Features to preserve (regression checklist)

Everything in `sideout.jsx`, explicitly including the newest ones:
- Director **proxy-add players in the lobby** ("no phone needed" — name + optional partner/team field).
- Director **walk-up pair** add mid-event (rotating pairs) and **walk-up player** add mid-event (mix, joins with priority = current max sat count).
- Mid-event adds for fixed-team round robin are intentionally **not** supported (would break the generated schedule) — leave it that way.
- PIN unlock for director controls, auto-unlock on the creating device (now via localStorage).
- Score corrections by anyone, clear-result by director; "no ties" validation; "set 21" shortcut.
- Active/inactive (IN/OUT) toggles feeding round generation; bye/sit fairness.
- Me tab device-remembered identity; two-tap event delete (must also delete the regs and results subcollections — use a batched delete).
- End event → final standings; reopen scoring.

## 9. Build order

1. Scaffold Vite app; drop `engine.js` + tests in; get `npm test` green.
2. Port UI from `sideout.jsx` into `App.jsx` (it can stay one big file — that's fine).
3. Write `src/store.js` exposing the same conceptual operations the UI already calls (load event, subscribe, register, save score, save cfg, delete event) backed by Firestore.
4. Wire snapshots; remove polling.
5. `firebase.json` (hosting config pointing at `dist/`) + `firestore.rules`; hand Jeff the rules to paste. Manifest + icons (simple "SO" mark, ink-on-paper colors, 192/512 px).
6. GitHub Action: build + deploy hosting on push to `main` using `FirebaseExtended/action-hosting-deploy` with the `FIREBASE_SERVICE_ACCOUNT` secret (walk Jeff through creating it — manual task #3). First successful Action run = the app is live at `sideout-vb.web.app`.
7. Manual two-browser test of all three formats end to end.

## 10. Acceptance

- Two browsers (one incognito) see each other's registrations and scores in ≤ 2 seconds, no refresh.
- All three formats run signup → start → rounds → final standings without console errors.
- Lighthouse says installable; Add to Home Screen works on iOS Safari and Android Chrome.
- Total Firestore ops for a simulated tournament day stay well inside Spark free limits (sanity math in README).
- `npm test` covers: RR correctness (5 teams → 10 unique matchups, one bye each), pairs fairness (byes max-diff 1 over 6 rounds), mix sit fairness (max-diff 1), small-group fallback, standings credit, mutual-partner pairing, named-team build with top-up.
