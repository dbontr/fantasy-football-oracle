"use strict";

const core = require("../app-core.js");
const {
  normalizeLeagueState,
  assessLeagueState,
  applyLeagueAction,
  leagueStateDigest,
  resolveSimulationTeams,
} = require("./league-state.js");
const { sha256 } = require("./lineage.js");

const CHAMPIONSHIP_OPTIMIZER_VERSION = "oracle-championship-2026.1";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function outcomeForTeam(simulation, teamId) {
  return simulation?.teams?.find((team) => String(team.teamId) === String(teamId)) || null;
}

function standardError(probability, simulations) {
  const p = clamp(probability, 0, 1);
  const n = Math.max(1, finite(simulations, 1));
  return Math.sqrt((p * (1 - p)) / n);
}

function actionCost(action, state) {
  if (!action || action.type === "none") return 0;
  const budget = Math.max(1, state.settings.faabBudget || 100);
  const faab = Math.max(0, finite(action.faabBid, 0)) / budget;
  const futureAsset = Math.max(0, finite(action.futureAssetCost, 0));
  const rosterChurn = (
    (action.sendPlayerIds?.length || 0) +
    (action.dropPlayerId ? 1 : 0)
  ) * 0.002;
  return clamp(faab * 0.025 + futureAsset * 0.02 + rosterChurn, 0, 0.2);
}

function equityScore(outcome, state, action = null) {
  if (!outcome) return Number.NEGATIVE_INFINITY;
  const remainingWeeks = Math.max(1, state.settings.regularSeasonEnd - state.week + 1);
  const expectedWinsRate = finite(outcome.expectedWins, 0) / remainingWeeks;
  const expectedPointsRate = finite(outcome.expectedPoints, 0) / remainingWeeks;
  const title = clamp(outcome.championshipProbability, 0, 1);
  const playoffs = clamp(outcome.playoffProbability, 0, 1);
  const allPlay = clamp(outcome.allPlayWinPct, 0, 1);
  const stage = clamp(state.week / Math.max(1, state.settings.regularSeasonEnd), 0, 1);
  const titleWeight = 0.66 + stage * 0.12;
  const playoffWeight = 0.16 - stage * 0.06;
  const strengthWeight = 0.1;
  const winsWeight = 0.05;
  const pointsWeight = 0.03;
  const score = title * titleWeight + playoffs * playoffWeight +
    allPlay * strengthWeight + clamp(expectedWinsRate, 0, 1) * winsWeight +
    clamp(expectedPointsRate / 180, 0, 1.5) * pointsWeight - actionCost(action, state);
  return Math.round(score * 1_000_000) / 10_000;
}

function actionLabel(action, index) {
  if (!action || action.type === "none") return "Current roster";
  if (action.label) return String(action.label);
  if (action.type === "add-drop" || action.type === "waiver") {
    return `Add ${action.addPlayerId}${action.dropPlayerId ? `, drop ${action.dropPlayerId}` : ""}`;
  }
  if (action.type === "trade") {
    return `Trade ${action.sendPlayerIds?.join("+") || "assets"} for ${action.receivePlayerIds?.join("+") || "assets"}`;
  }
  return `Action ${index + 1}`;
}

function compareOutcomes(candidate, baseline) {
  const fields = [
    "championshipProbability",
    "playoffProbability",
    "expectedWins",
    "expectedPoints",
    "allPlayWinPct",
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    Math.round((finite(candidate?.[field], 0) - finite(baseline?.[field], 0)) * 10_000) / 10_000,
  ]));
}

function confidenceForComparison(candidate, baseline, simulations, completeness) {
  const candidateError = standardError(candidate?.championshipProbability, simulations);
  const baselineError = standardError(baseline?.championshipProbability, simulations);
  const combined = Math.sqrt(candidateError ** 2 + baselineError ** 2);
  const margin = Math.abs(
    finite(candidate?.championshipProbability, 0) - finite(baseline?.championshipProbability, 0),
  );
  const signal = combined > 0 ? margin / combined : 0;
  return Math.round(clamp((0.42 + Math.min(0.5, signal * 0.12)) * completeness, 0.05, 0.98) * 1000) / 1000;
}

function reversalConditions(row, best) {
  if (!best || row.id === best.id) {
    return {
      titleProbabilityNeeded: 0,
      description: "This is the current highest-ranked action under the loaded league state.",
    };
  }
  const titleGap = Math.max(0, finite(best.outcome?.championshipProbability) - finite(row.outcome?.championshipProbability));
  const scoreGap = Math.max(0, finite(best.equityScore) - finite(row.equityScore));
  return {
    titleProbabilityNeeded: Math.round(titleGap * 10_000) / 10_000,
    equityScoreNeeded: Math.round(scoreGap * 100) / 100,
    description: `This action would need roughly ${(titleGap * 100).toFixed(2)} additional title-probability points, or an equivalent cost/risk advantage, to become preferred.`,
  };
}

class ChampionshipOptimizer {
  constructor(options = {}) {
    if (!options.pool) throw new TypeError("ChampionshipOptimizer requires pool");
    if (!options.datasetProvider) throw new TypeError("ChampionshipOptimizer requires datasetProvider");
    this.pool = options.pool;
    this.datasetProvider = options.datasetProvider;
    this.metrics = options.metrics || null;
    this.maxActions = Math.max(1, Number(options.maxActions || 24));
    this.timeoutMs = Math.max(10_000, Number(options.timeoutMs || 180_000));
  }

  async simulate(state, simulations, seed) {
    const dataset = this.datasetProvider();
    const teams = resolveSimulationTeams(state, dataset.players);
    if (teams.some((team) => !team.roster.length)) {
      const error = new Error("Championship simulation requires every loaded team to have recognized players");
      error.code = "LEAGUE_ROSTER_INCOMPLETE";
      throw error;
    }
    const payload = {
      teams,
      schedule: state.schedule,
      settings: core.cloneSettings({ ...state.settings, teams: state.teams.length }),
      startWeek: state.week,
      regularSeasonEnd: state.settings.regularSeasonEnd,
      championshipWeek: state.settings.championshipWeek,
      playoffTeams: state.settings.playoffTeams,
      playoffByes: state.settings.playoffByes,
      medianGame: state.settings.medianGame,
      simulations,
      seed,
    };
    return this.pool.run("league-simulate", payload, { timeoutMs: this.timeoutMs });
  }

  async evaluate(options = {}) {
    const state = normalizeLeagueState(options.leagueState || {});
    const assessment = assessLeagueState(state);
    if (!assessment.valid) {
      const error = new Error(`League state is invalid: ${assessment.errors.join("; ")}`);
      error.code = "LEAGUE_STATE_INVALID";
      error.details = assessment;
      throw error;
    }
    const simulations = Math.min(250_000, Math.max(500, Number(options.simulations || 20_000)));
    const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 2026;
    const actions = [{ type: "none", label: "Current roster" }, ...(
      Array.isArray(options.actions) ? options.actions.slice(0, this.maxActions) : []
    )];
    const rows = [];
    const startedAt = Date.now();
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const candidateState = action.type === "none" ? state : applyLeagueAction(state, action);
      const run = await this.simulate(candidateState, simulations, seed);
      const outcome = outcomeForTeam(run.data, state.userTeamId);
      if (!outcome) {
        const error = new Error(`Simulation did not return user team ${state.userTeamId}`);
        error.code = "SIMULATION_TEAM_MISSING";
        throw error;
      }
      rows.push({
        id: String(action.id || sha256({ action, index }).slice(0, 20)),
        label: actionLabel(action, index),
        action,
        stateDigest: leagueStateDigest(candidateState),
        outcome,
        simulation: {
          engine: run.engine || "oracle-javascript-fallback",
          engineVersion: run.engineVersion || null,
          computeMs: run.computeMs,
          simulations: run.data?.simulations || simulations,
          model: run.data?.model || null,
        },
        equityScore: equityScore(outcome, state, action),
      });
    }
    const baseline = rows[0];
    rows.forEach((row) => {
      row.delta = compareOutcomes(row.outcome, baseline.outcome);
      row.confidence = confidenceForComparison(
        row.outcome,
        baseline.outcome,
        simulations,
        assessment.confidence,
      );
    });
    rows.sort((left, right) => (
      finite(right.outcome.championshipProbability) - finite(left.outcome.championshipProbability) ||
      right.equityScore - left.equityScore ||
      finite(right.outcome.playoffProbability) - finite(left.outcome.playoffProbability) ||
      finite(right.outcome.allPlayWinPct) - finite(left.outcome.allPlayWinPct)
    ));
    const best = rows[0];
    rows.forEach((row, rank) => {
      row.rank = rank + 1;
      row.reversal = reversalConditions(row, best);
      row.recommendation = row.id === best.id
        ? (row.action.type === "none" ? "Hold current roster" : "Preferred championship action")
        : "Alternative";
    });
    const elapsedMs = Date.now() - startedAt;
    this.metrics?.observe("championship_evaluate_duration_ms", elapsedMs, {
      actions: actions.length,
      engine: best.simulation.engine,
    });
    this.metrics?.increment("championship_evaluate_total", 1, { outcome: "success" });
    return {
      version: CHAMPIONSHIP_OPTIMIZER_VERSION,
      objective: "maximize-championship-probability",
      evaluatedAt: new Date().toISOString(),
      leagueStateDigest: leagueStateDigest(state),
      leagueAssessment: assessment,
      pairedSeed: seed,
      simulations,
      elapsedMs,
      baselineId: baseline.id,
      preferredActionId: best.id,
      preferredAction: best.action,
      baseline: {
        outcome: baseline.outcome,
        equityScore: baseline.equityScore,
      },
      actions: rows,
      warnings: [
        ...assessment.warnings,
        "Probabilities are model estimates, not guarantees.",
        "Candidate ranking is conditional on the supplied rosters, schedule, rules, and player distributions.",
      ],
    };
  }

  status() {
    return {
      version: CHAMPIONSHIP_OPTIMIZER_VERSION,
      objective: "maximize-championship-probability",
      pairedScenarioEvaluation: true,
      maxActions: this.maxActions,
      timeoutMs: this.timeoutMs,
      nativeLeagueSimulation: true,
      supportedActions: ["none", "add-drop", "waiver", "trade", "roster-set", "draft"],
    };
  }
}

module.exports = {
  CHAMPIONSHIP_OPTIMIZER_VERSION,
  ChampionshipOptimizer,
  outcomeForTeam,
  equityScore,
  compareOutcomes,
  standardError,
  confidenceForComparison,
};
