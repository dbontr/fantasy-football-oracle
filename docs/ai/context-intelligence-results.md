# Context Intelligence Results

Version: `oracle-context-2026.1`

Application release: `3.2.0`

Native engine release: `1.1.0`

## Implemented models

The contextual layer runs after the coaching-adjusted projection ensemble and before the modeled dataset is loaded into persistent C++ workers.

It adds:

- team offense, passing, rushing, defense, and skill-concentration indices
- position share, role rank, team skill share, depth gap, and role certainty
- weekly matchup and playoff schedule grades
- ADP, prior-production, and source-projection disagreement
- breakout probability, bust probability, and upside/downside asymmetry
- fragility, conviction, and normalized uncertainty attribution
- player archetypes and ranked explanatory drivers
- native expected-regret and counterfactual start/sit analysis

The direct projection effects are centered by position and bounded to prevent systematic inflation.## Dataset diagnostics

Bundled 2026 dataset:

- players modeled: 700
- NFL teams profiled: 32
- active-player contextual mean factor: 0.99912
- minimum contextual mean factor: 0.9732
- maximum contextual mean factor: 1.0190

The matchup model uses opponent offense and DST projections as low-confidence proxies. It does not claim to observe coverage, pass rush, fronts, routes, or participation.

## Native decision regret

For each selected starter and eligible bench alternative, the C++ engine computes:

- correlation-adjusted score-difference variance
- probability the starter outscores the alternative
- probability the alternative outscores the starter
- expected positive regret if the alternative wins
- 80% decision swing
- slot fragility

The roster summary reports total expected regret, average regret, fragile decision count, and the highest-cost counterfactual.## Browser validation

Representative 15-player roster, Week 6:

- opportunity certainty: 80/100
- ecosystem strength: 68/100
- matchup outlook: 47/100
- roster fragility: 18%
- expected lineup regret: 5.4 points
- fragile decisions: 2
- highest counterfactual: Jaxon Smith-Njigba over CeeDee Lamb
- five conviction rows, five upside rows, and five fragility/counterfactual rows rendered
- draft recommendation displayed archetype, opportunity, and conviction
- waiver recommendation displayed opportunity and upside alongside FAAB
- 390-pixel viewport had no horizontal overflow
- no page errors or console errors

## Verification

The release passed 48 automated tests with zero high-severity dependency advisories.

Coverage includes contextual centering, role differentiation, uncertainty normalization, API routing, native regret bounds, C++/JavaScript parity, dataset preload, and worker crash recovery.

The screenshot from the final browser run is stored locally at `C:\Temp\fantasy-intelligence-v2.png` and is not committed.