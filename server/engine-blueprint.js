"use strict";

const ENGINE_BLUEPRINT_VERSION = "oracle-blueprint-2026.8-free-learning-v5.1";

const LAYERS = [
  {
    id: "temporal-intelligence",
    name: "Temporal evidence and probabilistic decision intelligence",
    weight: 10,
    status: "implemented",
    available: ["append-only evidence ledger", "hash-chain verification", "as-of replay", "expiry and freshness decay", "source reliability", "conflict-aware reconciliation", "zero-inflated player distributions", "aleatoric and epistemic uncertainty", "paired robust portfolio evaluation", "probability of best", "expected regret", "risk sensitivity", "Pareto frontier", "value of information"],
    missing: ["automatic licensed-feed acquisition", "causal treatment-effect estimation", "online posterior learning from manager actions"],
  },
  {
    id: "free-learning",
    name: "Zero-cost public evidence and continuous probabilistic learning",
    weight: 9,
    status: "implemented",
    available: ["offline-by-default public connectors", "conditional disk cache", "origin and redirect allowlists", "response byte limits", "stale-if-error", "source circuit breakers", "Sleeper identity and trend evidence", "nflverse identity and weekly outcomes", "opt-in Open-Meteo game weather", "append-only forecast journal", "proper probabilistic scores", "position-aware calibration", "final-season holdout gate", "production-journal challenger promotion"],
    missing: ["free play-level route geometry", "free historical injury archive", "multi-season production journal outcomes", "automated causal calibration"],
  },
  {
    id: "opportunity",
    name: "Opportunity and expected fantasy points",
    weight: 12,
    status: "implemented",
    available: ["weekly projections", "role stability", "ownership", "start rate", "historical carries and targets", "target share", "air-yards share", "WOPR", "usage trend", "volume stability", "age and experience curves", "position-specific ridge forecasts", "untouched holdout validation", "breakout and regression archetypes"],
    missing: ["actual routes", "targets per route", "red-zone opportunity feed", "play-level expected fantasy points model"],
  },
  {
    id: "tracking",
    name: "Player tracking, routes, and coverage",
    weight: 10,
    status: "partial",
    available: ["versioned tracking evidence schema", "source reconciliation", "separation and route-win forecast effects"],
    missing: ["connected route geometry feed", "coverage shell", "defender leverage", "speed and acceleration"],
  },
  {
    id: "coaching",
    name: "Coaching, leadership, scheme, and development",
    weight: 9,
    status: "implemented",
    available: ["current staff", "play caller", "scheme", "continuity", "leadership", "role clarity", "position development"],
    missing: ["automated historical staff attribution", "coach-player longitudinal estimates"],
  },
  {
    id: "line",
    name: "Offensive line and pass protection",
    weight: 7,
    status: "partial",
    available: ["versioned line-grade evidence schema", "pass-block and run-block forecast effects", "time-decayed source reconciliation"],
    missing: ["connected pressure responsibility feed", "run-block win rate", "pass-block win rate", "line injuries"],
  },
];
LAYERS.push(
  {
    id: "health",
    name: "Injury, workload, and availability",
    weight: 9,
    status: "implemented",
    available: ["live injury designation", "body part", "practice participation", "surgical note", "historical availability rates", "return window", "weekly snap-performance ramp", "return-to-prior-level probability", "recurrence risk", "age adjustment", "news freshness"],
    missing: ["complete medical history", "surgery date", "rehabilitation testing", "team medical clearance feed"],
  },
  {
    id: "environment",
    name: "Weather, venue, and game environment",
    weight: 6,
    status: "partial",
    available: ["home or away", "canonical game ids", "venue map", "indoor and roofed venue override", "kickoff", "bye week", "opt-in Open-Meteo wind", "opt-in Open-Meteo precipitation", "opt-in Open-Meteo temperature"],
    missing: ["commercial weather service fallback", "field surface", "travel and rest", "roof-open status"],
  },
  {
    id: "markets",
    name: "Betting and projection markets",
    weight: 8,
    status: "partial",
    available: ["player-prop evidence contract", "team total, game total, and spread contracts", "multi-source weighted consensus", "conflict-driven uncertainty widening"],
    missing: ["connected sportsbook feeds", "line movement history", "vig removal", "multi-book identity resolution"],
  },
  {
    id: "matchup",
    name: "Opponent and tactical matchup",
    weight: 8,
    status: "partial",
    available: ["schedule", "opponent", "home or away", "opponent DST and offense proxy", "weekly matchup grades", "playoff schedule outlook"],
    missing: ["coverage tendencies", "pass rush", "run fronts", "man-zone splits", "shadow coverage"],
  },
);
LAYERS.push(
  {
    id: "news",
    name: "News, depth chart, and transactions",
    weight: 6,
    status: "partial",
    available: ["ESPN player-tagged news", "freshness decay", "injury and return language", "practice fields", "depth-chart order", "reported-versus-modeled separation", "conservative multi-athlete attribution"],
    missing: ["full beat-writer feed", "official transaction stream", "automatic article-body extraction", "trained event classifier"],
  },
  {
    id: "market-value",
    name: "Draft and roster market value",
    weight: 7,
    status: "implemented",
    available: ["ADP", "auction value", "ownership", "start rate", "replacement value", "VONA"],
    missing: ["multi-platform ADP", "expert consensus", "real-time auction rooms"],
  },
  {
    id: "league-utility",
    name: "League-specific utility and game theory",
    weight: 7,
    status: "implemented",
    available: ["scoring", "slots", "replacement levels", "opponent rosters", "current standings", "future schedule", "playoff format", "median games", "FAAB", "trade fairness", "championship-equity action ranking", "paired candidate seeds"],
    missing: ["full keeper-cost engine", "dynasty age curves", "trained manager-behavior learning"],
  },
  {
    id: "simulation",
    name: "Correlated simulation and optimization",
    weight: 8,
    status: "implemented",
    available: ["draft Monte Carlo", "lineup assignment", "season distributions", "exact current standings", "points-for tiebreak context", "median games", "explicit playoff byes", "league playoffs", "CVaR", "team-aware starter correlation", "expected decision regret", "paired championship actions", "counterfactual reversal thresholds", "game and team latent factors", "position-specific correlation", "availability mixtures", "order-independent seeded scenarios", "robust portfolio utility", "probability-of-best ranking", "Pareto frontiers", "risk-aversion sensitivity"],
    missing: ["automatic multi-lineup late-swap portfolio optimization", "play-level drive simulation", "learned copula calibration"],
  },
);
LAYERS.push(
  {
    id: "calibration",
    name: "Backtesting, calibration, and drift detection",
    weight: 8,
    status: "implemented",
    available: ["deterministic parity tests", "bounds tests", "model versioning", "source lineage", "artifact checksums", "multi-season leakage-safe replay", "walk-forward policy tuning", "untouched holdout evaluation", "mandatory champion-challenger gates", "instant model rollback", "historical trade and waiver calibration", "historical value curves", "coverage diagnostics", "season-held-out ridge selection", "Brier score", "log loss", "pinball loss", "weighted interval score", "calibration bins", "numeric MAE and RMSE", "80-percent interval coverage", "forecast journal replay", "latest pre-outcome snapshot selection", "persistent outcome drift monitoring"],
    missing: ["real manager acceptance calibration", "fully automated causal drift diagnosis"],
  },
  {
    id: "explainability",
    name: "Explainability and counterfactual decisions",
    weight: 5,
    status: "partial",
    available: ["VONA reasons", "coaching drivers", "lineup alternatives", "trade deltas", "FAAB ranges", "uncertainty decomposition", "player archetypes", "expected regret", "breakout and bust asymmetry", "evidence provenance", "source conflict", "family-capped contributions", "value-of-information ranking", "counterfactual evidence overlays"],
    missing: ["trained-model SHAP attribution", "causal attribution"],
  },
);

Object.freeze(LAYERS);

const STATUS_CREDIT = Object.freeze({ implemented: 1, partial: .5, planned: 0 });

function modelBlueprint(dataset = {}) {
  const maximum = LAYERS.reduce((sum, layer) => sum + layer.weight, 0);
  const achieved = LAYERS.reduce((sum, layer) => (
    sum + layer.weight * STATUS_CREDIT[layer.status]
  ), 0);
  const layers = LAYERS.map((layer) => ({ ...layer }));
  return {
    version: ENGINE_BLUEPRINT_VERSION,
    modelVersion: dataset?.meta?.modelVersion || null,
    contextVersion: dataset?.meta?.contextVersion || null,
    intelligenceDiagnostics: dataset?.intelligence?.diagnostics || null,
    generatedAt: new Date().toISOString(),
    readinessScore: Math.round((achieved / maximum) * 100),
    implemented: layers.filter((layer) => layer.status === "implemented").length,
    partial: layers.filter((layer) => layer.status === "partial").length,
    planned: layers.filter((layer) => layer.status === "planned").length,
    layers,
  };
}

module.exports = { ENGINE_BLUEPRINT_VERSION, LAYERS, modelBlueprint };
