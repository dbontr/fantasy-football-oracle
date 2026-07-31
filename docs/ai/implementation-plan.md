# Fantasy Football Oracle implementation plan

## Product goal

Create a static GitHub Pages application that turns live league state into a recommended next action during drafts and throughout the season.

## Browser-first constraints

- Draft state, rosters, credentials, and user preferences stay in the browser.
- The bundled player snapshot makes the application usable without a connector.
- Remote integrations are read-only and optional.
- ESPN private-league data is accepted through a local browser userscript bridge; no session cookie is committed or sent to this repository.

## Phase 1 scope

1. Snake-draft setup, live pick entry, undo, team board, and ranked recommendations.
2. Manual roster management and optimized starters.
3. Waiver upgrade analysis using available players and live Sleeper trends.
4. Multi-player trade analysis using lineup impact, depth, scarcity, and fairness.
5. Public Sleeper league import plus experimental ESPN public import and userscript bridge.
6. Local persistence, export/import, responsive UI, and accessibility support.

## Decision model

- Value over replacement is calculated from league roster settings.
- Draft recommendations combine projected points, scarcity, roster need, ADP value, tier cliffs, injury risk, and roster construction.
- Lineups are optimized against slot eligibility rather than using a fixed positional sort.
- Trades are scored using before/after optimized lineups plus bench depth and rest-of-season asset value.
- Waiver suggestions identify the best legal add/drop pair and show projected lineup or depth improvement.

## Verification

- Unit tests cover snake order, draft scoring, lineup optimization, trade evaluation, and waiver analysis.
- Syntax checks cover every browser and build script.
- Browser verification covers wide and narrow layouts, keyboard focus, local persistence, draft interactions, and connector error states.
