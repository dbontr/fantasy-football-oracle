"use strict";
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = __dirname;
const isWindows = process.platform === "win32";
const binaryName = isWindows ? "oracle-engine.exe" : "oracle-engine";
const output = path.join(root, "bin", binaryName);
const metadataPath = path.join(root, "bin", "build-metadata.json");
const sources = [
  path.join(root, "src", "main.cpp"),
  path.join(root, "src", "engine.cpp"),
];
const flags = [
  "-std=c++20",
  "-O3",
  "-DNDEBUG",
  "-Wall",
  "-Wextra",
  "-Wpedantic",
  ...(isWindows ? ["-static", "-static-libgcc", "-static-libstdc++"] : []),
];
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
function compilerCandidates() {
  return unique([
    process.env.CXX,
    isWindows ? path.join(os.homedir(), "Tools", "w64devkit", "bin", "g++.exe") : null,
    isWindows ? "C:\\msys64\\ucrt64\\bin\\g++.exe" : null,
    isWindows ? "C:\\msys64\\mingw64\\bin\\g++.exe" : null,
    isWindows ? "C:\\ProgramData\\chocolatey\\bin\\g++.exe" : null,
    "g++",
    "clang++",
  ]);
}
function compilerEnvironment(command) {
  const compilerDir = path.dirname(command);
  if (compilerDir === ".") return process.env;
  return {
    ...process.env,
    PATH: `${compilerDir}${path.delimiter}${process.env.PATH || ""}`,
  };
}
function compilerVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: compilerEnvironment(command),
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}
function inputDigest(version) {
  const hash = createHash("sha256");
  hash.update("oracle-native-build-v3\0");
  hash.update(version);
  hash.update("\0builder\0");
  hash.update(fs.readFileSync(__filename));
  for (const flag of flags) hash.update(`\0flag:${flag}`);
  for (const source of sources) {
    hash.update(`\0source:${path.relative(root, source).replaceAll("\\", "/")}\0`);
    hash.update(fs.readFileSync(source));
  }
  return hash.digest("hex");
}
function readMetadata() {
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}
function cleanupBackups() {
  const directory = path.dirname(output);
  const prefix = `${binaryName}.`;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".bak")) continue;
    try {
      fs.rmSync(path.join(directory, entry.name), { force: true });
    } catch {
      // A running Windows process can keep its renamed executable locked.
    }
  }
}
function probe(binary) {
  if (!fs.existsSync(binary)) return null;
  const result = spawnSync(binary, ["--capabilities"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  try {
    const capabilities = JSON.parse(result.stdout.trim());
    return capabilities.engine === "oracle-native" ? capabilities : null;
  } catch {
    return null;
  }
}
function writeMetadata(metadata) {
  const temporary = `${metadataPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, metadataPath);
  } catch {
    fs.rmSync(metadataPath, { force: true });
    fs.renameSync(temporary, metadataPath);
  }
}
function replaceBinary(temporary) {
  if (!isWindows) {
    fs.renameSync(temporary, output);
    return;
  }
  const backup = `${output}.${process.pid}.bak`;
  let movedExisting = false;
  try {
    if (fs.existsSync(output)) {
      fs.renameSync(output, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, output);
    if (movedExisting) {
      try {
        fs.rmSync(backup, { force: true });
      } catch (cleanupError) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(cleanupError.code)) throw cleanupError;
        console.warn(`Previous native engine remains active at ${backup}; cleanup is deferred.`);
      }
    }
  } catch (error) {
    if (!fs.existsSync(output) && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, output);
      } catch (restoreError) {
        error.restoreError = restoreError;
      }
    }
    if (["EACCES", "EBUSY", "EPERM"].includes(error.code)) {
      console.error(
        `Cannot replace ${output} while it is running. Stop the Oracle server, `
        + "then run npm run build:native again.",
      );
    }
    throw error;
  }
}
function fail(message, error = null) {
  console.error(message);
  if (error) console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  cleanupBackups();
  let compiler = null;
  let version = null;
  for (const candidate of compilerCandidates()) {
    const detected = compilerVersion(candidate);
    if (!detected) continue;
    compiler = candidate;
    version = detected;
    break;
  }
  if (!compiler) {
    fail("No C++20 compiler found. Set CXX or install GCC/Clang.");
    return;
  }
  const digest = inputDigest(version);
  const metadata = readMetadata();
  const force = ["1", "true", "yes"].includes(
    String(process.env.ORACLE_FORCE_NATIVE_REBUILD || "").toLowerCase(),
  );
  const capabilities = !force && metadata?.inputDigest === digest ? probe(output) : null;
  if (capabilities) {
    console.log(`Native engine is up to date: ${output}`);
    console.log(JSON.stringify(capabilities));
    return;
  }
  const temporary = path.join(
    root,
    "bin",
    `oracle-engine-build-${process.pid}-${Date.now()}${isWindows ? ".exe" : ""}`,
  );
  try {
    console.log(`Building native engine with ${compiler}`);
    const result = spawnSync(compiler, [...flags, ...sources, "-o", temporary], {
      stdio: "inherit",
      env: compilerEnvironment(compiler),
      windowsHide: true,
    });
    if (result.status !== 0) {
      fail("Native compiler failed.", result.error);
      return;
    }
    const builtCapabilities = probe(temporary);
    if (!builtCapabilities) {
      fail("Native engine smoke test failed.");
      return;
    }
    replaceBinary(temporary);
    writeMetadata({
      schemaVersion: 1,
      inputDigest: digest,
      compiler: path.basename(compiler),
      compilerVersion: version.split(/\r?\n/, 1)[0],
      flags,
      capabilities: builtCapabilities,
    });
    console.log(JSON.stringify(builtCapabilities));
    console.log(`Native engine: ${output}`);
  } catch (error) {
    fail("Native engine build failed.", error);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
main();
