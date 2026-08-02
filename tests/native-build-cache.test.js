"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
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
