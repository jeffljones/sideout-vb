# SIDEOUT 🏐

Phone-first tournament day engine for recreational sand & grass volleyball.
One person (the director) creates an event and gets a 4-letter join code;
players join from their phones, register, and anyone can enter scores.
Built for direct Florida sun, sandy thumbs, and venues where some players
carry no phone at all (the director proxy-registers them).

**Live app:** https://sideout-vb.web.app

## Formats

1. **Fixed teams tournament** (2s–6s) — pool play round robin (one pool, or
   two pools side by side), then **double-elimination playoffs**: seeded
   from pool standings (cross-seeded A1, B1, A2, B2… with two pools),
   best-of-3 winners bracket and grand final (e.g. 21/21/15, win by two,
   no cap), single-game losers bracket. If the losers-bracket team takes
   the grand final, a single deciding game is *offered* — generating it is
   the director's call (house rules sometimes let the Bo3 stand).
2. **Rotating pairs** — keep one partner all day; each round, pairs combine
   into 4s matches with history-weighted grouping to minimize repeat
   teammates/opponents, fair bye rotation, leftover two pairs play 2v2.
3. **Pickup mix** — random teams every round, individual standings, sit-out
   fairness (most-benched players go in first), small-group fallback
   shrinks team size instead of skipping a round.

Tournament-day realities the flow is built around: multiple levels run as
separate events (separate codes); the playoff **seeding screen is
editable** — reorder seeds, pull a team that moved up a level, add one
that moved down — because divisions get rebalanced after pool play. A
"straight to bracket" option at lock-in supports day-two divisions that
are hand-seeded off day-one results. Rally vs sideout scoring needs no
app support — final scores are final scores. Mid-*bracket* roster changes
are deliberately unsupported (they would corrupt double-elim routing).

**Self-reffing is scheduled in** (`m.ref`, teams format): pool matches are
reffed by the bye team when there is one, otherwise by a team from the
round's other matchup, balanced across the day (played-twice matchups
share one ref). In the bracket, the losing team refs the next game — the
most recently beaten free team gets the whistle; round one uses the bye
teams, worst seed first, and the top seed is spared first-game duty
unless they're the only option. The Schedule tab shows a per-court
**now / next strip** with refs so courts never idle.

## Stack

- **Vite + React 18**, plain JavaScript, single-page app (`src/App.jsx`).
- **Firestore** for data with realtime `onSnapshot` sync; **Firebase
  Hosting** for the app. Free Spark plan.
- **PWA-lite:** manifest + icons so players can Add to Home Screen.
  Deliberately **no service worker** — scores need network anyway, and a
  stale cache courtside is worse than a spinner.
- Deploys run from GitHub Actions on push to `main`
  (`.github/workflows/deploy.yml`). There is no local Firebase CLI flow.

```
src/engine.js       pure scheduling/standings logic (no I/O) + tests in engine.test.js
src/store.js        every Firestore read/write the UI uses, plus localStorage helpers
src/firebase.js     web app config (public-safe) — paste from the Firebase console
src/App.jsx         the entire UI
firestore.rules     source of truth for rules; deployed by console paste
scripts/gen-icons.mjs  regenerates public/icons (npm run icons)
```

## Development

```bash
npm install
npm run dev     # local dev server (talks to the real Firestore)
npm test        # vitest — engine invariants (formats, fairness, standings)
npm run build   # production build into dist/
```

## Data model

```
events/{CODE}                    the event config doc
  name, format ('teams'|'pairs'|'mix'), teamSize, courts, pointsTo, pin,
  status ('signup'|'live'|'done'), created, roster, groups, sched, rds,
  mseq, byes, sit, inact, sat,
  stage (''|'pool'|'playoff'), pools (1|2), poolGames (1|2),
  seeds [groupId…], po { g12, g3 }       ← playoff config (teams format)
events/{CODE}/regs/{autoId}      { name, extra, ts }
events/{CODE}/results/{matchId}  { a, b, ts }
```

Bracket matches use deterministic ids (`w1s2`, `l3s1`, `gf`, `gf2`) and
best-of-3 series store **one result doc per game** (`w1s2g1`…`w1s2g3`),
so the results schema never changes shape.

Conventions (documented, not enforced):

- **The cfg doc is single-writer.** Only the director's device writes it:
  round generation, roster lock, IN/OUT toggles, walk-ups, status changes.
- **Results are one doc per match.** Writing again is a correction;
  deleting clears the result. Anyone may write — honor system.
- **Regs are deduped client-side** by lowercase name, latest `ts` wins.

## Trust model — read this before renaming the rules file

This is a rec-league honor system, on purpose. There are **no user
accounts** and there should not be any. Anyone with the URL can read
events and write scores; the director PIN is a UI-level gate, not a
security boundary. The Firestore rules (`firestore.rules`) only validate
document shape and cap sizes so vandalism stays boring.

Consequences:

- **Nothing sensitive goes in event names or player names. First names
  (plus an initial) work great.**
- Anyone can correct a score — that's a feature on a windy sand court.
- A determined vandal could scribble on an event; the director can fix
  scores, remove regs, or delete the event. The blast radius is one
  volleyball day.

## Firestore free-tier sanity math

A busy tournament day, generously estimated: 40 players, ~30 active
phones, 8 rounds, ~45 matches.

Writes:
- registrations ~40, cfg writes (rounds + toggles + walk-ups + status) ~35,
  results incl. corrections ~55 → **~130 writes** vs **20,000/day** free.

Reads (each phone's listeners pay one doc read per changed/initial doc):
- initial subscribes: 30 phones × (1 cfg + ~20 results avg) ≈ 650
- lobby phase: 40 reg docs × 30 phones ≈ 1,200
- live fan-out: (35 cfg + 55 result writes) × 30 phones ≈ 2,700
- landing "recents" queries: ~60 visits × 8 docs ≈ 500

→ **~5,000–6,000 reads** vs **50,000/day** free. Roughly 10× headroom;
even a triple-header weekend with reconnect churn stays comfortably
inside the Spark plan.

## One-time project setup (manual, in the browser)

The Firebase project is `sideout-vb` (Firestore in `us-east1`). Three
things can't be done from code:

1. **Web app config** — Firebase console → ⚙️ Project settings → Your
   apps → Add app (Web) → register "SIDEOUT" → copy the `firebaseConfig`
   object into `src/firebase.js`. It is public-safe by design.
2. **Rules** — paste the full contents of `firestore.rules` at Firebase
   console → Firestore Database → Rules → Publish. The repo file is the
   source of truth; re-paste whenever it changes.
3. **Deploy credentials** — create a service account
   (console.cloud.google.com → IAM & Admin → Service Accounts → Create,
   name `github-deployer`, role **Firebase Hosting Admin**), add a JSON
   key, and paste the key contents into this GitHub repo as the Actions
   secret `FIREBASE_SERVICE_ACCOUNT`.

After that, every push to `main` tests, builds, and deploys to
https://sideout-vb.web.app automatically.
