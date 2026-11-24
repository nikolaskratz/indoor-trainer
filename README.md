# Indoor Trainer

Personal indoor cycling app: generate workouts from a prompt, run them in ERG mode on a
smart trainer over Web Bluetooth, record the ride and upload it to Strava.

Current state: **hardware check page** only. It verifies that Chrome can read and control the
trainer (FTMS) and read a Bluetooth heart rate strap.

- `npm run dev` then open the printed URL in Chrome (Web Bluetooth needs Chrome or Edge).
- Add `?sim=1` to the URL to use simulated devices instead of real Bluetooth.
- `npm test` runs the unit tests for the Bluetooth byte parsers.
- `npm run build && npm i --no-save playwright-core && npm run e2e` runs the page against the
  simulated devices in Google Chrome.
