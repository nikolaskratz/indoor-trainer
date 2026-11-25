# Indoor Trainer

Personal indoor cycling app: run structured workouts in ERG mode on a smart trainer over Web
Bluetooth, record the ride with heart rate, and export it for Strava. Runs in Chrome on a Mac.

Live: https://nikolaskratz.github.io/indoor-trainer/

## What works

- Ready-made workouts with a preview (duration, intensity, training stress).
- Ride screen: target and actual power, heart rate, cadence, step countdown, workout graph with
  progress; pause, skip, intensity adjustment, auto-pause, beeps.
- Trainer control over FTMS, with automatic reconnect; heart rate strap.
- Recording once a second, distance from a power-based speed model on a flat road.
- Ride summary, history and TCX file download.
- Floating window during a ride (Chrome's Document Picture-in-Picture): a small always-on-top
  window with power, target, step time and heart rate.
- FTP test: a ramp test among the built-in workouts; the summary estimates FTP as 75 % of the
  best minute and can write it to the profile.
- Storage: everything lives in the browser (localStorage, IndexedDB) and the app works from
  that copy. When signed in, `src/lib/sync.ts` mirrors profile, workouts and rides to the
  tables `turbo_profile`, `turbo_workouts` and `turbo_rides` (see `supabase/migrations`); per
  item the side that changed it last wins, deletions are kept as markers.
- Hardware check page (`#/check`) to verify trainer and strap.

- Workouts from a description ("45 min easy Z2 with some variations"): sign in; the Supabase
  edge function `supabase/functions/turbo-workout` asks Claude for a structured workout. The
  function must be deployed to the Supabase project once.
- Change a workout with a second description ("make the warm-up shorter") on its page: your own
  workouts change in place (with an undo), a built-in one is saved as a changed copy. Same edge
  function, called with the current workout as `base`.

- Strava: connect once (profile page), then upload a finished ride from its summary as a virtual
  ride. Server side: edge function `supabase/functions/turbo-strava` plus the table in
  `supabase/migrations`; needs the secrets `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.

- Several people: the owner (the account in `tri_owners`) adds email addresses under "People
  with access" on the profile page; each person creates their own account on the start page.
  Everyone gets only their own rows (`turbo_access()` in `supabase/migrations`, also checked by
  both edge functions); an account that was not added can sign in but uses the app in its
  browser only. A browser that holds one account's data exchanges nothing with another account
  until the user hands the browser over on the profile page. Strava limits a new API
  application to one athlete until Strava raises the limit, so other people may have to upload
  the downloaded ride file by hand.

## Development

- `npm run dev`, then open the printed URL in Chrome (Web Bluetooth needs Chrome or Edge).
- Add `?sim=1` to the URL to use simulated devices instead of real Bluetooth
  (for example `/?sim=1#/`). `&speed=20` runs the ride clock 20 times faster.
- `npm test` runs the unit tests.
- `npm run build && npm i --no-save playwright-core && npm run e2e` runs the hardware check and
  a full simulated ride, the prompt and Strava flows, account sync between two browsers (backend
  mocked), the FTP test with the floating window, and several accounts, in Google Chrome.

Layout: `src/ble` Bluetooth (FTMS, heart rate, simulated devices), `src/domain` workout model,
ride session, metrics and TCX export (no browser code), `src/lib` storage and glue,
`src/pages` screens.
