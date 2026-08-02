"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bundled = require("../data/players-2026.json");
const {
  stableStringify,
  sha256,
  createLineage,
  verifyLineage,
  createRecommendationEnvelope,
  verifyRecommendationEnvelope,
} = require("../server/lineage.js");
const {
  normalizeSourceRecord,
  validateRecord,
} = require("../server/schema-registry.js");
const {
  EVENT_STORE_VERSION,
  GENESIS_HASH,
  EventStore,
  verifyEventChain,
} = require("../server/event-store.js");
const { recoverBestEventChain } = require("../scripts/repair-event-store.js");
const { SnapshotCatalog } = require("../server/snapshot-catalog.js");
const { DecisionLedger } = require("../server/decision-ledger.js");
const {
  CircuitBreaker,
  ResilientProvider,
  retry,
} = require("../server/resilience.js");
const {
  MetricsRegistry,
  ComponentHealthRegistry,
  evaluateSLOs,
} = require("../server/observability.js");
const {
  normalizeLeagueState,
  assessLeagueState,
  applyLeagueAction,
  leagueStateDigest,
} = require("../server/league-state.js");
const {
  ChampionshipOptimizer,
  equityScore,
} = require("../server/championship-optimizer.js");
const {
  buildArtifactManifest,
  writeArtifactManifest,
  validateArtifactManifest,
} = require("../server/artifact-registry.js");
const { ModelRegistry, promotionGate } = require("../server/model-registry.js");
const { DriftMonitor, summarizeRows } = require("../server/drift-monitor.js");
const { createPackageDirectory } = require("../scripts/backup-oracle.js");
const { verifyGitBundle } = require("../scripts/verify-backup.js");
const { cloneBundleCanonical, prepareDrillPaths, runNpm } = require("../scripts/disaster-recovery-drill.js");
const {
  run,
  checksumEntries,
  verifyChecksumEntries,
  encryptFile,
  decryptFile,
} = require("../scripts/lib/recovery.js");

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-platform-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeLeagueState() {
  const players = bundled.players.slice(0, 48);
  const teams = Array.from({ length: 4 }, (_, index) => ({
    teamId: String(index + 1),
    name: `Team ${index + 1}`,
    rosterIds: players.slice(index * 10, index * 10 + 10).map((player) => player.id),
    wins: index,
    losses: 3 - index,
    faabRemaining: 100 - index * 10,
  }));
  return {
    leagueId: "test-league",
    season: 2026,
    week: 6,
    userTeamId: "1",
    settings: {
      teams: 4,
      scoring: "ppr",
      regularSeasonEnd: 14,
      championshipWeek: 17,
      playoffTeams: 2,
      playoffByes: 0,
      faabBudget: 100,
    },
    teams,
    schedule: [
      { week: 6, homeTeamId: "1", awayTeamId: "2" },
      { week: 6, homeTeamId: "3", awayTeamId: "4" },
    ],
    source: { provider: "test", fetchedAt: "2026-08-01T00:00:00.000Z" },
  };
}

test("lineage is deterministic and detects payload mutation", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
  const payload = { playerId: "1", status: "questionable" };
  const lineage = createLineage({
    kind: "injury",
    schemaVersion: "injury/v1",
    source: "test",
    fetchedAt: "2026-08-01T00:00:00.000Z",
    payload,
  });
  assert.equal(verifyLineage(lineage, payload).valid, true);
  assert.equal(verifyLineage(lineage, { ...payload, status: "out" }).valid, false);
});

test("source records preserve provenance and validate", () => {
  const record = normalizeSourceRecord({
    id: "test:1",
    entityType: "player-news",
    source: "test",
    sourceRecordId: "1",
    eventAt: "2026-08-01T12:00:00.000Z",
    fetchedAt: "2026-08-01T12:01:00.000Z",
    confidence: 0.9,
    usage: "test-only",
    payload: { headline: "Player returns to practice" },
  });
  assert.equal(validateRecord("sourceRecord", record).valid, true);
  assert.equal(record.lineage.source, "test");
  assert.equal(record.source.confidence, 0.9);
});

test("recommendation envelopes have deterministic replay keys", () => {
  const options = {
    decisionType: "waiver",
    input: { add: "1", drop: "2" },
    model: { version: "test" },
    data: { snapshot: "abc" },
    seed: 2026,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const first = createRecommendationEnvelope(options);
  const second = createRecommendationEnvelope({ ...options, createdAt: "2026-08-02T00:00:00.000Z" });
  assert.equal(first.replayKey, second.replayKey);
  assert.notEqual(first.decisionId, second.decisionId);
  assert.equal(verifyRecommendationEnvelope(first), true);
});

test("event store is append-only and tamper evident", async (t) => {
  const directory = await tempDirectory(t);
  let now = Date.parse("2026-08-01T00:00:00.000Z");
  const store = new EventStore({
    filePath: path.join(directory, "events.jsonl"),
    clock: () => new Date(now += 1000),
  });
  await store.initialize();
  await store.append("test.created", { value: 1 });
  await store.append("test.updated", { value: 2 });
  assert.equal(store.status().events, 2);
  assert.equal(store.verify().valid, true);
  const events = store.list({ limit: 10 });
  const tampered = events.map((event) => ({ ...event }));
  tampered[0].payload.value = 999;
  assert.equal(verifyEventChain(tampered).valid, false);
  await store.close();
});

test("event store prevents concurrent writers and releases its lease", async (t) => {
  const directory = await tempDirectory(t);
  const filePath = path.join(directory, "exclusive.jsonl");
  const first = new EventStore({ filePath });
  const second = new EventStore({ filePath });
  await first.initialize();
  await assert.rejects(() => second.initialize(), { code: "EVENT_STORE_LOCKED" });
  await first.append("first", { value: 1 });
  await first.close();
  await second.initialize();
  await second.append("second", { value: 2 });
  assert.equal(second.verify().valid, true);
  assert.equal(second.status().events, 2);
  await second.close();
});

test("event recovery selects the longest cryptographically valid branch", () => {
  const makeEvent = (sequence, previousHash, id) => {
    const base = {
      version: EVENT_STORE_VERSION,
      sequence,
      id,
      type: "test.event",
      occurredAt: "2026-08-01T00:00:00.000Z",
      recordedAt: `2026-08-01T00:00:0${sequence}.000Z`,
      source: "test",
      previousHash,
      payload: { id },
      metadata: {},
    };
    return { ...base, hash: sha256(base) };
  };
  const first = makeEvent(1, GENESIS_HASH, "first");
  const shortBranch = makeEvent(2, first.hash, "short");
  const longBranch = makeEvent(2, first.hash, "long");
  const longHead = makeEvent(3, longBranch.hash, "long-head");
  const recovery = recoverBestEventChain(
    [first, shortBranch, longBranch, longHead].map(JSON.stringify).join("\n"),
  );
  assert.equal(recovery.verification.valid, true);
  assert.deepEqual(recovery.chain.map((event) => event.id), ["first", "long", "long-head"]);
  assert.equal(recovery.discardedEvents, 1);
});

test("snapshot catalog deduplicates identical payloads and verifies bytes", async (t) => {
  const directory = await tempDirectory(t);
  const catalog = new SnapshotCatalog({ directory });
  await catalog.initialize();
  const first = await catalog.write("players", { rows: [1, 2, 3] });
  const second = await catalog.write("players", { rows: [1, 2, 3] });
  assert.equal(first.digest, second.digest);
  assert.equal(catalog.status().snapshots, 1);
  assert.deepEqual((await catalog.read(first.digest)).payload.rows, [1, 2, 3]);
  assert.equal((await catalog.verify()).valid, true);
});

test("decision ledger records replayable results and outcomes", async (t) => {
  const directory = await tempDirectory(t);
  const events = new EventStore({ filePath: path.join(directory, "decisions.jsonl") });
  const snapshots = new SnapshotCatalog({ directory: path.join(directory, "snapshots") });
  await snapshots.initialize();
  await events.initialize();
  const ledger = new DecisionLedger({ eventStore: events, snapshotCatalog: snapshots });
  await ledger.initialize();
  const envelope = createRecommendationEnvelope({
    decisionType: "trade",
    input: { send: ["1"], receive: ["2"] },
    model: { version: "test" },
    data: { etag: "test" },
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  await ledger.recordDecision(envelope, { decision: "accept", score: 10 });
  await ledger.recordOutcome(envelope.decisionId, { metrics: { actualGain: 12 } });
  assert.equal(ledger.findDecision(envelope.decisionId).envelope.replayKey, envelope.replayKey);
  assert.equal(ledger.outcomesFor(envelope.decisionId)[0].metrics.actualGain, 12);
});

test("retry is bounded and circuit breaker recovers through half-open", async () => {
  let attempts = 0;
  const value = await retry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("temporary"), { code: "ECONNRESET" });
    return 42;
  }, { attempts: 3, baseDelayMs: 0, sleep: async () => {} });
  assert.equal(value, 42);
  assert.equal(attempts, 3);

  let now = 1_000;
  const breaker = new CircuitBreaker({
    name: "test",
    failureThreshold: 2,
    resetTimeoutMs: 100,
    clock: () => now,
  });
  await assert.rejects(() => breaker.run(async () => { throw new Error("one"); }));
  await assert.rejects(() => breaker.run(async () => { throw new Error("two"); }));
  assert.equal(breaker.status().state, "open");
  await assert.rejects(() => breaker.run(async () => 1), { code: "CIRCUIT_OPEN" });
  now += 101;
  assert.equal(await breaker.run(async () => 7), 7);
  assert.equal(breaker.status().state, "closed");
});

test("resilient provider serves labeled last-known-good data", async () => {
  let now = 1_000;
  const provider = new ResilientProvider({
    name: "test",
    clock: () => now,
    timeoutMs: 100,
    maxStaleMs: 1_000,
    retry: { attempts: 1 },
  });
  const live = await provider.execute("players", async () => ({ players: 700 }));
  assert.equal(live.source, "live");
  now += 100;
  const degraded = await provider.execute("players", async () => {
    throw new Error("provider unavailable");
  });
  assert.equal(degraded.source, "last-known-good");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.value.players, 700);
});

test("metrics expose percentiles and freshness-aware component health", async () => {
  let now = 10_000;
  const metrics = new MetricsRegistry({ clock: () => now });
  metrics.increment("requests", 2, { route: "draft" });
  [10, 20, 30, 100].forEach((value) => metrics.observe("draft_duration_ms", value));
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters["requests{route=draft}"], 2);
  assert.equal(snapshot.histograms.draft_duration_ms.p95, 100);
  const slos = evaluateSLOs(snapshot, { latencyP95Ms: { draft_duration_ms: 120 } });
  assert.equal(slos.met, true);

  const health = new ComponentHealthRegistry({ clock: () => now });
  health.set("players", "healthy", {
    observedAt: new Date(now - 50).toISOString(),
    maxAgeMs: 100,
  });
  assert.equal(health.snapshot().state, "healthy");
  now += 100;
  assert.equal(health.snapshot().state, "stale");
});

test("league state is exact, detects duplicates, and applies actions", () => {
  const raw = makeLeagueState();
  const state = normalizeLeagueState(raw);
  const assessment = assessLeagueState(state);
  assert.equal(assessment.valid, true);
  assert.ok(assessment.completeness > 0.8);
  const freeAgent = bundled.players[45].id;
  const drop = state.teams[0].rosterIds[0];
  const changed = applyLeagueAction(state, {
    type: "add-drop",
    teamId: "1",
    addPlayerId: freeAgent,
    dropPlayerId: drop,
    faabBid: 12,
  });
  assert.ok(changed.teams[0].rosterIds.includes(String(freeAgent)));
  assert.equal(changed.teams[0].faabRemaining, 88);
  assert.notEqual(leagueStateDigest(changed), leagueStateDigest(state));

  const duplicate = structuredClone(raw);
  duplicate.teams[1].rosterIds.push(duplicate.teams[0].rosterIds[0]);
  assert.equal(assessLeagueState(normalizeLeagueState(duplicate)).valid, false);
});

test("championship equity score prioritizes title probability", () => {
  const state = normalizeLeagueState(makeLeagueState());
  const strongTitle = { championshipProbability: 0.3, playoffProbability: 0.6, expectedWins: 5, expectedPoints: 900, allPlayWinPct: 0.52 };
  const weakTitle = { championshipProbability: 0.2, playoffProbability: 0.9, expectedWins: 7, expectedPoints: 1000, allPlayWinPct: 0.6 };
  assert.ok(equityScore(strongTitle, state) > equityScore(weakTitle, state));
});

test("championship optimizer uses paired seeds and ranks title-equity actions", async () => {
  const raw = makeLeagueState();
  const target = bundled.players[45];
  const drop = raw.teams[0].rosterIds[0];
  const seeds = [];
  const pool = {
    async run(type, payload) {
      assert.equal(type, "league-simulate");
      seeds.push(payload.seed);
      const user = payload.teams.find((team) => team.teamId === "1");
      const improved = user.roster.some((player) => String(player.id) === String(target.id));
      const userTitle = improved ? 0.26 : 0.12;
      return {
        engine: "oracle-native",
        engineVersion: "test",
        computeMs: 5,
        data: {
          simulations: payload.simulations,
          model: "test-league-model",
          teams: payload.teams.map((team, index) => ({
            teamId: team.teamId,
            championshipProbability: team.teamId === "1" ? userTitle : (1 - userTitle) / 3,
            playoffProbability: team.teamId === "1" ? (improved ? 0.72 : 0.55) : 0.5,
            expectedWins: team.teamId === "1" ? (improved ? 6 : 5) : 4,
            expectedPoints: team.teamId === "1" ? (improved ? 1000 : 900) : 850 - index,
            allPlayWinPct: team.teamId === "1" ? (improved ? 0.61 : 0.52) : 0.48,
          })),
        },
      };
    },
  };
  const optimizer = new ChampionshipOptimizer({
    pool,
    datasetProvider: () => bundled,
  });
  const result = await optimizer.evaluate({
    leagueState: raw,
    simulations: 2_000,
    seed: 77,
    actions: [{
      id: "upgrade",
      type: "add-drop",
      teamId: "1",
      addPlayerId: target.id,
      dropPlayerId: drop,
      faabBid: 5,
    }],
  });
  assert.deepEqual(seeds, [77, 77]);
  assert.equal(result.preferredActionId, "upgrade");
  assert.ok(result.actions[0].delta.championshipProbability > 0);
  assert.equal(result.actions[0].recommendation, "Preferred championship action");
});

test("artifact manifest detects changed or missing critical bytes", async (t) => {
  const directory = await tempDirectory(t);
  await fs.writeFile(path.join(directory, "a.json"), "{\"a\":1}\n", "utf8");
  await fs.writeFile(path.join(directory, "b.txt"), "stable\n", "utf8");
  const manifest = await buildArtifactManifest(directory, ["a.json", "b.txt"], {
    commit: "test",
    generatedAt: null,
  });
  await writeArtifactManifest(path.join(directory, "manifest.json"), manifest);
  assert.equal((await validateArtifactManifest(directory, manifest)).valid, true);
  await fs.writeFile(path.join(directory, "b.txt"), "mutated\n", "utf8");
  const invalid = await validateArtifactManifest(directory, manifest);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /b\.txt/);
});

test("champion-challenger gate requires a real holdout and supports rollback", async (t) => {
  const directory = await tempDirectory(t);
  const seedPath = path.join(directory, "seed.json");
  const runtimePath = path.join(directory, "runtime.json");
  await fs.writeFile(seedPath, JSON.stringify({
    version: "oracle-model-registry-2026.1",
    domains: {
      projection: {
        champion: "champion-v1",
        models: {
          "champion-v1": { status: "production", rollback: null },
        },
      },
    },
  }), "utf8");
  const registry = new ModelRegistry({ seedPath, runtimePath });
  await registry.initialize();
  registry.registerChallenger("projection", { version: "challenger-v2" });
  await registry.persist();
  const rejected = await registry.evaluateAndPromote("projection", "challenger-v2", {
    primaryMetric: "rmse",
    direction: "lower",
    championValue: 3,
    challengerValue: 2.9,
    minimumImprovement: 0.05,
    sampleSize: 20,
    minimumSampleSize: 100,
    leakageSafe: false,
  });
  assert.equal(rejected.evaluation.passed, false);
  registry.registerChallenger("projection", { version: "challenger-v3" });
  await registry.persist();
  const promoted = await registry.evaluateAndPromote("projection", "challenger-v3", {
    primaryMetric: "rmse",
    direction: "lower",
    championValue: 3,
    challengerValue: 2.8,
    minimumImprovement: 0.05,
    sampleSize: 304,
    minimumSampleSize: 100,
    leakageSafe: true,
    holdoutSeason: 2025,
  });
  assert.equal(promoted.evaluation.passed, true);
  assert.equal(registry.status().domains.projection.champion, "challenger-v3");
  const rolledBack = await registry.rollback("projection");
  assert.equal(rolledBack.to, "champion-v1");
});

test("promotion gate rejects cosmetic challengers", () => {
  const gate = promotionGate(
    { version: "champion" },
    { version: "challenger" },
    {
      primaryMetric: "correlation",
      direction: "higher",
      championValue: 0.7,
      challengerValue: 0.705,
      minimumImprovement: 0.02,
      sampleSize: 500,
      minimumSampleSize: 100,
      leakageSafe: true,
      holdoutId: "untouched-2025",
    },
  );
  assert.equal(gate.passed, false);
  assert.match(gate.errors.join(" "), /improvement/);
});

test("drift monitor measures calibration and persists observations", async (t) => {
  const directory = await tempDirectory(t);
  const monitor = new DriftMonitor({
    filePath: path.join(directory, "drift.json"),
    baselines: { projection: { brier: 0.12 } },
    thresholds: { minimumSamples: 10, brierIncreaseDegraded: 0.03, brierIncreaseUnsafe: 0.08 },
  });
  await monitor.initialize();
  for (let index = 0; index < 20; index += 1) {
    const prediction = index % 2 ? 0.8 : 0.2;
    const outcome = index % 2 ? 1 : 0;
    await monitor.record({
      domain: "projection",
      modelVersion: "model-v1",
      metric: "start-probability",
      metricType: "probability",
      prediction,
      outcome,
    });
  }
  const report = monitor.report({ domain: "projection" });
  assert.equal(report.summary.samples, 20);
  assert.ok(report.summary.brier < 0.1);
  assert.equal(report.assessment.state, "healthy");
  const reloaded = new DriftMonitor({ filePath: path.join(directory, "drift.json") });
  await reloaded.initialize();
  assert.equal(reloaded.status().observations, 20);
});

test("drift summaries expose numeric error and probability calibration", () => {
  const summary = summarizeRows([
    { metricType: "numeric", prediction: 10, outcome: 8 },
    { metricType: "numeric", prediction: 7, outcome: 8 },
    { metricType: "probability", prediction: 0.8, outcome: 1 },
    { metricType: "probability", prediction: 0.2, outcome: 0 },
  ]);
  assert.equal(summary.numericSamples, 2);
  assert.equal(summary.probabilitySamples, 2);
  assert.equal(summary.numericMae, 1.5);
  assert.ok(summary.brier < 0.05);
});

test("recovery npm invocation works on the host platform", () => {
  const result = runNpm(["--version"]);
  assert.match(String(result.stdout || "").trim(), /^\d+\.\d+\.\d+/);
});
test("bundle verification works outside an existing repository", async (t) => {
  const directory = await tempDirectory(t);
  const source = path.join(directory, "source");
  const bundle = path.join(directory, "repository.bundle");
  await fs.mkdir(source);
  run("git", ["init", source]);
  await fs.writeFile(path.join(source, "README.md"), "recovery test\n", "utf8");
  run("git", ["-C", source, "add", "README.md"]);
  run("git", [
    "-C", source,
    "-c", "user.name=Oracle Test",
    "-c", "user.email=oracle-test@example.invalid",
    "commit", "-m", "recovery fixture",
  ]);
  run("git", ["-C", source, "bundle", "create", bundle, "--all"]);
  assert.equal(await verifyGitBundle(bundle), true);
});
test("recovery checkout preserves exact Git blob bytes", async (t) => {
  const directory = await tempDirectory(t);
  const source = path.join(directory, "canonical-source");
  const bundle = path.join(directory, "canonical.bundle");
  const restored = path.join(directory, "restored");
  await fs.mkdir(source);
  run("git", ["init", source]);
  await fs.writeFile(path.join(source, "lf.txt"), "line one\nline two\n", "utf8");
  await fs.writeFile(path.join(source, "crlf.txt"), "line one\r\nline two\r\n", "utf8");
  run("git", ["-c", "core.autocrlf=false", "-C", source, "add", "lf.txt", "crlf.txt"]);
  run("git", [
    "-C", source,
    "-c", "user.name=Oracle Test",
    "-c", "user.email=oracle-test@example.invalid",
    "commit", "-m", "canonical bytes",
  ]);
  const commit = String(run("git", ["-C", source, "rev-parse", "HEAD"]).stdout).trim();
  run("git", ["-C", source, "bundle", "create", bundle, "--all"]);
  cloneBundleCanonical(bundle, restored, commit);
  assert.equal(await fs.readFile(path.join(restored, "lf.txt"), "utf8"), "line one\nline two\n");
  assert.equal(await fs.readFile(path.join(restored, "crlf.txt"), "utf8"), "line one\r\nline two\r\n");
});

test("recovery paths create a missing explicit destination", async (t) => {
  const directory = await tempDirectory(t);
  const destination = path.join(directory, "missing", "nested", "drill");
  const paths = await prepareDrillPaths(destination);
  assert.equal(paths.drillRoot, destination);
  assert.equal(paths.restoredRepo, path.join(destination, "fantasy-football-oracle"));
  assert.equal((await fs.stat(destination)).isDirectory(), true);
  await fs.mkdir(paths.restoredRepo);
  await assert.rejects(() => prepareDrillPaths(destination), {
    code: "RECOVERY_DESTINATION_NOT_EMPTY",
  });
});
test("backup creation makes a missing nested output root", async (t) => {
  const directory = await tempDirectory(t);
  const outputRoot = path.join(directory, "missing", "nested", "recovery");
  const packageDirectory = await createPackageDirectory(outputRoot, "oracle-test-package");
  assert.equal(packageDirectory, path.join(outputRoot, "oracle-test-package"));
  assert.equal((await fs.stat(packageDirectory)).isDirectory(), true);
  await assert.rejects(
    () => createPackageDirectory(outputRoot, "oracle-test-package"),
    { code: "EEXIST" },
  );
});
test("recovery checksums and encryption detect altered data", async (t) => {
  const directory = await tempDirectory(t);
  const source = path.join(directory, "source.bin");
  const encrypted = path.join(directory, "source.bin.enc");
  const restored = path.join(directory, "restored.bin");
  await fs.writeFile(source, Buffer.from("critical oracle recovery payload"));
  const entries = await checksumEntries(directory, ["source.bin"]);
  assert.equal((await verifyChecksumEntries(directory, entries)).valid, true);
  await encryptFile(source, encrypted, "correct horse battery staple");
  await decryptFile(encrypted, restored, "correct horse battery staple");
  assert.deepEqual(await fs.readFile(restored), await fs.readFile(source));
  await fs.writeFile(source, Buffer.from("tampered"));
  assert.equal((await verifyChecksumEntries(directory, entries)).valid, false);
  await assert.rejects(
    () => decryptFile(encrypted, path.join(directory, "wrong.bin"), "wrong passphrase"),
  );
});
