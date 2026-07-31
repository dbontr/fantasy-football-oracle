# Fantasy Football Oracle

A browser-first fantasy football command center for live drafts and in-season team management.

## Live site

`https://dbontr.github.io/fantasy-football-oracle/`

## What it does

### Live draft room

- Configure team count, snake position, scoring, roster slots, rounds, and risk tolerance.
- Record each pick in order or override the team when picks are traded.
- See the full draft board, every roster, and the distance to your next pick.
- Get a constantly updated recommendation based on:
  - projected points and value over replacement
  - open starter and flex needs
  - positional scarcity and tier cliffs
  - ADP value and falling players
  - injury risk and user risk tolerance
  - roster-construction penalties for early kickers, defenses, and redundant positions
- Undo or reset the draft at any time.

### Team manager

- Use the roster drafted in the app, enter a roster manually, or import a league.
- Optimize starters against exact QB/RB/WR/TE/FLEX/SUPERFLEX/DST/K eligibility.
- Compare available players against the weakest legal add/drop option.
- Add Sleeper's live trending activity to waiver recommendations.

### Trade lab

- Build multi-player trades from your roster and the player pool.
- Grade the deal using before/after optimized lineups, rest-of-season asset value, depth, scarcity, and injury risk.
- Show weekly lineup change, asset-value change, and fairness.

### League connections

- Sleeper: import public league settings, rosters, teams, completed draft picks, and poll active drafts every seven seconds.
- ESPN public leagues: import directly with league ID, season, and team ID.
- ESPN private leagues: install the optional userscript bridge in `tools/espn-oracle.user.js` and start sync while logged into ESPN.
- Oracle JSON: export and restore the entire browser state.
## Data

The repository includes a compact 2026 snapshot generated from ESPN's public fantasy player feed. It currently contains 700 players with:

- default PPR season projection
- prior-season fantasy points
- PPR, standard, and superflex draft ranks
- average draft position
- average auction value
- ownership and start rates
- team, position, and injury status

Rebuild the snapshot:

```bash
npm run build:data
```

Or choose another season and size:

```bash
node scripts/build-player-data.js --season 2026 --limit 700
```

The app can also attempt a live ESPN refresh from the Connect screen. If ESPN blocks the browser request, the bundled snapshot remains active.

## Privacy model

- There is no application backend.
- Drafts, rosters, settings, and trades are stored in browser local storage.
- Sleeper integration is read-only and does not require authentication.
- The ESPN bridge runs on the ESPN page and uses the user's existing ESPN session there.
- ESPN cookies, `SWID`, and `espn_s2` are never requested by or stored in the Oracle application.
- Exported Oracle JSON contains league state, so treat exported files as private.

## ESPN private-league bridge

1. Install a userscript manager such as Tampermonkey.
2. Open `tools/espn-oracle.user.js` from this repository and install it.
3. Open your ESPN Fantasy Football league or draft page while logged in.
4. Use the **Fantasy Football Oracle** panel added to the lower-right corner.
5. Click **Start live Oracle sync**.
6. Allow the Oracle tab to open. League and draft snapshots update every seven seconds while the ESPN tab remains open.

The bridge posts data only to `https://dbontr.github.io`.
## Local development

Serve the repository through HTTP so browser `fetch()` calls work:

```bash
npx serve .
```

Then open the local URL shown by the command.

Run verification:

```bash
npm run check
npm test
```

## Repository layout

- `index.html` — semantic application shell
- `styles.css` — responsive field, play-sheet, clipboard, and trade-lab design system
- `app-core.js` — testable recommendation, lineup, trade, waiver, and draft engine
- `app.js` — browser state, rendering, persistence, and league integrations
- `data/players-2026.json` — compact bundled player snapshot
- `scripts/build-player-data.js` — ESPN snapshot generator
- `tools/espn-oracle.user.js` — optional private ESPN bridge
- `tests/core.test.js` — decision-engine tests
- `docs/ai/implementation-plan.md` — architecture and scope

## Current limitations

- Recommendations are projection and roster-optimization tools, not guarantees.
- The initial model uses ESPN default PPR projections as its common scoring baseline; custom bonuses are approximated through league format and positional demand.
- ESPN does not provide a supported public authentication flow for a static third-party site. Private sync therefore requires the optional browser bridge.
- Waiver recommendations know which players are unavailable after a tracked/imported draft, but an incomplete manually entered league may still show players rostered elsewhere.
- News, weather, and depth-chart changes are represented only when reflected in the refreshed data sources.
