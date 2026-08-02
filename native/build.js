"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseNativeCapabilities } = require("./capabilities.js");
const { fileSha256 } = require("./integrity.js");

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
const BUILD_INPUT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".inc",
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function collectBuildInputs(rootDir = root) {
  const fixed = [
    path.join(rootDir, "build.js"),
    path.join(rootDir, "capabilities.js"),
    path.join(rootDir, "integrity.js"),
  ];
  const compiled = [
    ...walkFiles(path.join(rootDir, "src")),
    ...walkFiles(path.join(rootDir, "third_party")),
  ].filter((file) => BUILD_INPUT_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return unique([...fixed, ...compiled])
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => (
      path.relative(rootDir, left).localeCompare(path.relative(rootDir, right))
    ));
}

function versionedW64DevkitCandidates(homeDir = os.homedir()) {
  const toolsDir = path.join(homeDir, "Tools");
  try {
    return fs.readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^w64devkit/i.test(entry.name))
      .flatMap((entry) => {
        const base = path.join(toolsDir, entry.name);
        return [
          path.join(base, "bin", "g++.exe"),
          path.join(base, "w64devkit", "bin", "g++.exe"),
        ];
      });
  } catch {
    return [];
  }
}

function compilerCandidates(homeDir = os.homedir()) {
  return unique([
    process.env.CXX,
    isWindows ? path.join(homeDir, "Tools", "w64devkit", "bin", "g++.exe") : null,
    ...(isWindows ? versionedW64DevkitCandidates(homeDir) : []),
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

function compilerVersion(command, options = {}) {
  const result = (options.spawnSync || spawnSync)(command, ["--version"], {
    encoding: "utf8",
    env: compilerEnvironment(command),
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.status !== 0) return null;
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function inputDigest(version, options = {}) {
  const rootDir = options.rootDir || root;
  const selectedFlags = options.flags || flags;
  const inputs = options.inputs || collectBuildInputs(rootDir);
  const hash = createHash("sha256");
  hash.update("oracle-native-build-v4\0");
  hash.update(String(version || ""));
  for (const flag of selectedFlags) hash.update(`\0flag:${flag}`);
  for (const file of inputs) {
    const relative = path.relative(rootDir, file).replaceAll("\\", "/");
    hash.update(`\0input:${relative}\0`);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function readMetadata(filePath = metadataPath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function probe(binary, options = {}) {
  if (!fs.existsSync(binary)) return null;
  const result = (options.spawnSync || spawnSync)(binary, ["--capabilities"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  try {
    return parseNativeCapabilities(result.stdout);
  } catch {
    return null;
  }
}

function cachedBinaryCapabilities(options = {}) {
  const {
    metadata,
    digest,
    binary = output,
    probeFn = probe,
  } = options;
  if (
    metadata?.schemaVersion !== 2
    || metadata.inputDigest !== digest
    || !/^[a-f0-9]{64}$/i.test(metadata.binaryDigest || "")
    || !fs.existsSync(binary)
  ) return null;
  if (fileSha256(binary) !== metadata.binaryDigest) return null;
  return probeFn(binary);
}

function writeMetadata(metadata, filePath = metadataPath) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporary, filePath);
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
  const inputs = collectBuildInputs();
  const digest = inputDigest(version, { inputs });
  const metadata = readMetadata();
  const force = ["1", "true", "yes"].includes(
    String(process.env.ORACLE_FORCE_NATIVE_REBUILD || "").toLowerCase(),
  );
  const capabilities = force ? null : cachedBinaryCapabilities({ metadata, digest });
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
    const binaryDigest = fileSha256(output);
    writeMetadata({
      schemaVersion: 2,
      inputDigest: digest,
      binaryDigest,
      inputs: inputs.map((file) => path.relative(root, file).replaceAll("\\", "/")),
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

module.exports = {
  BUILD_INPUT_EXTENSIONS,
  cachedBinaryCapabilities,
  collectBuildInputs,
  compilerCandidates,
  compilerEnvironment,
  compilerVersion,
  inputDigest,
  main,
  probe,
  versionedW64DevkitCandidates,
};

if (require.main === module) main();
