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
- Ride summary, history and TCX file download. Everything is stored in the browser.
- Hardware check page (`#/check`) to verify trainer and strap.

- Workouts from a description ("45 min easy Z2 with some variations"): sign in with the Tri Coach
  account; the Supabase edge function `supabase/functions/turbo-workout` asks Claude for a
  structured workout. The function must be deployed to the Supabase project once.

- Strava: connect once (profile page), then upload a finished ride from its summary as a virtual
  ride. Server side: edge function `supabase/functions/turbo-strava` plus the table in
  `supabase/migrations`; needs the secrets `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.

Not built yet: cloud storage of rides and workouts.

## Development

- `npm run dev`, then open the printed URL in Chrome (Web Bluetooth needs Chrome or Edge).
- Add `?sim=1` to the URL to use simulated devices instead of real Bluetooth
  (for example `/?sim=1#/`). `&speed=20` runs the ride clock 20 times faster.
- `npm test` runs the unit tests.
- `npm run build && npm i --no-save playwright-core && npm run e2e` runs the hardware check and
  a full simulated ride, and the prompt and Strava flows (backend mocked) in Google Chrome.

Layout: `src/ble` Bluetooth (FTMS, heart rate, simulated devices), `src/domain` workout model,
ride session, metrics and TCX export (no browser code), `src/lib` storage and glue,
`src/pages` screens.
