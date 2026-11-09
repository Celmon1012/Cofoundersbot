# CoFoundersLab Connector

Local dashboard at http://localhost:3000 that sends CoFoundersLab connection requests with your default note, paced with random delays and capped per day.

## Setup (once)

Requires Node.js 18+.

```bash
cd cfl-connector
npm install        # also downloads the Chromium browser Playwright uses
npm start
```

Open http://localhost:3000.

## Use

1. **Open browser** – a Chromium window opens on CoFoundersLab. Log in there the first time; the login is saved in `data/browser-profile`.
2. Optional: in that window, set any search filters you want, then copy the URL into **Start page** and save.
3. **Start** – it clicks Connect on each card, pastes your note, presses Send, waits a random 40–100 s, and moves to the next page when one is done.
4. **Stop** any time. Keep the browser window open while it runs (it can be minimized).

## Safety stops

- Stops at the **daily limit** (resets at midnight UTC).
- Stops after **3 failed sends in a row** (usually means the site is rate-limiting or your plan's limit is hit).
- Stops if you get logged out or close the browser window.

Settings and history are stored in `data/config.json` and `data/state.json`.

## Note

Automated bulk requests may go against CoFoundersLab's terms and can get an account restricted. Lower the daily limit or raise the delays if you see failures.
