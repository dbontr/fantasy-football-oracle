"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  cachedBinaryCapabilities,
  collectBuildInputs,
  compilerCandidates,
  inputDigest,
} = require("../native/build.js");
const { fileSha256 } = require("../native/integrity.js");

const root = path.resolve(__dirname, "..");
const buildScript = path.join(root, "native", "build.js");
const binary = path.join(
  root,
  "native",
  "bin",
  process.platform === "win32" ? "oracle-engine.exe" : "oracle-engine",
);

function build() {
  return spawnSync(process.execPath, [buildScript], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
}

test("native build reuses a verified cached executable", { timeout: 45_000 }, () => {
  const initial = build();
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  assert.equal(fs.existsSync(binary), true);
  const before = fs.statSync(binary);
  const cached = build();
  assert.equal(cached.status, 0, cached.stderr || cached.stdout);
  assert.match(cached.stdout, /up to date/i);
  assert.equal(fs.statSync(binary).mtimeMs, before.mtimeMs);
});

test("native build digest covers headers, include fragments, and vendored headers", (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-native-inputs-"));
  const sourceRoot = path.join(root, "native");
  fs.cpSync(sourceRoot, tempRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      return !relative || !relative.split(path.sep).includes("bin");
    },
  });
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const inputs = collectBuildInputs(tempRoot);
  const relativeInputs = inputs.map((file) => path.relative(tempRoot, file).replaceAll("\\", "/"));
  assert.ok(relativeInputs.includes("src/engine.hpp"));
  assert.ok(relativeInputs.includes("src/advanced.inc"));
  assert.ok(relativeInputs.includes("third_party/nlohmann/json.hpp"));

  const before = inputDigest("test-compiler", { rootDir: tempRoot, inputs, flags: ["-O3"] });
  fs.appendFileSync(path.join(tempRoot, "src", "advanced.inc"), "\n// cache invalidation probe\n");
  const after = inputDigest("test-compiler", {
    rootDir: tempRoot,
    inputs: collectBuildInputs(tempRoot),
    flags: ["-O3"],
  });
  assert.notEqual(after, before);
});

test("cached native binaries require a matching binary digest", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-native-cache-"));
  const candidate = path.join(directory, "oracle-engine");
  fs.writeFileSync(candidate, "verified bytes");
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metadata = {
    schemaVersion: 2,
    inputDigest: "input-digest",
    binaryDigest: fileSha256(candidate),
  };
  const capabilities = { engine: "oracle-native", protocol: 1, tasks: [] };
  assert.equal(cachedBinaryCapabilities({
    metadata,
    digest: "input-digest",
    binary: candidate,
    probeFn: () => capabilities,
  }), capabilities);
  fs.appendFileSync(candidate, "tampered");
  assert.equal(cachedBinaryCapabilities({
    metadata,
    digest: "input-digest",
    binary: candidate,
    probeFn: () => capabilities,
  }), null);
});

test("compiler discovery finds versioned w64devkit layouts", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-toolchain-"));
  const compiler = path.join(home, "Tools", "w64devkit-2.9.0", "w64devkit", "bin", "g++.exe");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, "");
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (process.platform === "win32") assert.ok(compilerCandidates(home).includes(compiler));
});
