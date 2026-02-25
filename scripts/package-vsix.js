/**
 * Build and optionally publish platform-specific VSIX packages with the
 * correct DuckDB native bindings.
 *
 * Usage:
 *   node scripts/package-vsix.js                       # VSIX for current OS
 *   node scripts/package-vsix.js --all                  # VSIX for every target
 *   node scripts/package-vsix.js --target win32-x64     # single platform target
 *   node scripts/package-vsix.js --universal            # one fat VSIX (all platforms)
 *   node scripts/package-vsix.js --publish              # build + publish all targets
 *   node scripts/package-vsix.js --publish --pre-release # publish as pre-release
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DUCKDB_DIR = path.join(ROOT, "node_modules", "@duckdb");
const EXT_DIR = path.join(ROOT, "duckdb-extensions");
const BUNDLE_DIR = path.join(EXT_DIR, "bundle");

const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
];

// VS Code target → DuckDB platform name
const PLATFORM_MAP = {
  "darwin-arm64": "osx_arm64",
  "darwin-x64": "osx_amd64",
  "linux-x64": "linux_amd64",
  "win32-x64": "windows_amd64",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDuckDBBindingsVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(DUCKDB_DIR, "node-bindings", "package.json"),
      "utf8"
    )
  );
  return pkg.version;
}

/** Strip -r.X suffix: "1.4.4-r.1" → "1.4.4" */
function getDuckDBCoreVersion() {
  return getDuckDBBindingsVersion().replace(/-r\.\d+$/, "");
}

function installedPlatforms() {
  return PLATFORMS.filter((p) =>
    fs.existsSync(path.join(DUCKDB_DIR, `node-bindings-${p}`))
  );
}

function installBindings(platforms, version) {
  const already = installedPlatforms();
  const needed = platforms.filter((p) => !already.includes(p));
  if (needed.length === 0) return;

  const pkgs = needed
    .map((p) => `@duckdb/node-bindings-${p}@${version}`)
    .join(" ");
  console.log(`Installing DuckDB bindings: ${needed.join(", ")}`);
  execSync(`npm install ${pkgs} --force --no-save`, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

function removeBindings(platforms) {
  for (const p of platforms) {
    const dir = path.join(DUCKDB_DIR, `node-bindings-${p}`);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// DuckDB extension bundling
// ---------------------------------------------------------------------------

function validateExtensions() {
  const versionFile = path.join(EXT_DIR, "version.json");
  if (!fs.existsSync(versionFile)) {
    console.error(
      `\nError: duckdb-extensions/version.json not found.\nRun "node scripts/download-extensions.js" first.\n`
    );
    process.exit(1);
  }

  const { duckdbVersion } = JSON.parse(fs.readFileSync(versionFile, "utf8"));
  const currentVersion = getDuckDBCoreVersion();
  if (duckdbVersion !== currentVersion) {
    console.error(
      `\nError: Downloaded extensions are for DuckDB ${duckdbVersion}, but current version is ${currentVersion}.\nRun "node scripts/download-extensions.js" to re-download.\n`
    );
    process.exit(1);
  }

  console.log(`DuckDB extensions validated (v${currentVersion})`);
}

/** Copy extensions for a single platform into bundle/ (flat). */
function stageExtensionsForPlatform(platform) {
  cleanBundle();
  const duckdbPlatform = PLATFORM_MAP[platform];
  const srcDir = path.join(EXT_DIR, duckdbPlatform);
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });

  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(BUNDLE_DIR, file));
  }
  console.log(`Staged extensions for ${platform} (${duckdbPlatform})`);
}

/** Copy extensions for all platforms into bundle/{platform}/. */
function stageExtensionsUniversal() {
  cleanBundle();
  for (const platform of PLATFORMS) {
    const duckdbPlatform = PLATFORM_MAP[platform];
    const srcDir = path.join(EXT_DIR, duckdbPlatform);
    const destDir = path.join(BUNDLE_DIR, duckdbPlatform);
    fs.mkdirSync(destDir, { recursive: true });

    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  }
  console.log("Staged extensions for all platforms (universal)");
}

function cleanBundle() {
  if (fs.existsSync(BUNDLE_DIR)) {
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

/** Swap node_modules so only `platform`'s binding is present, run `fn`, then restore. */
function withPlatformBindings(platform, version, fn) {
  const others = PLATFORMS.filter((p) => p !== platform);
  const toRestore = others.filter((p) => installedPlatforms().includes(p));
  removeBindings(others);
  installBindings([platform], version);
  try {
    fn();
  } finally {
    // Restore previously-installed bindings
    if (toRestore.length > 0) installBindings(toRestore, version);
  }
}

function runVsce(subcmd, target, extraFlags = []) {
  const parts = ["vsce", subcmd];
  if (target) parts.push("--target", target);
  parts.push(...extraFlags);
  const cmd = parts.join(" ");
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const version = getDuckDBBindingsVersion();
const isPublish = args.includes("--publish");
const subcmd = isPublish ? "publish" : "package";
const extraFlags = args.includes("--pre-release") ? ["--pre-release"] : [];

// Validate downloaded extensions before any build
validateExtensions();

if (args.includes("--universal")) {
  installBindings(PLATFORMS, version);
  stageExtensionsUniversal();
  try {
    runVsce(subcmd, null, extraFlags);
  } finally {
    cleanBundle();
  }
} else if (args.includes("--all") || isPublish) {
  // Build (and optionally publish) a VSIX for every supported target.
  // Each iteration swaps in just that platform's native binding.
  const originallyInstalled = installedPlatforms();

  for (const platform of PLATFORMS) {
    const others = PLATFORMS.filter((p) => p !== platform);
    removeBindings(others);
    installBindings([platform], version);
    stageExtensionsForPlatform(platform);
    try {
      runVsce(subcmd, platform, extraFlags);
    } finally {
      cleanBundle();
    }
  }

  // Restore original state
  removeBindings(PLATFORMS);
  installBindings(originallyInstalled, version);
} else if (args.includes("--target")) {
  const idx = args.indexOf("--target");
  const target = args[idx + 1];
  if (!target || !PLATFORMS.includes(target)) {
    console.error(
      `Invalid target "${target}". Valid targets: ${PLATFORMS.join(", ")}`
    );
    process.exit(1);
  }
  withPlatformBindings(target, version, () => {
    stageExtensionsForPlatform(target);
    try {
      runVsce(subcmd, target, extraFlags);
    } finally {
      cleanBundle();
    }
  });
} else {
  // Default: current platform
  const current = `${process.platform}-${process.arch}`;
  if (!PLATFORMS.includes(current)) {
    console.error(`Current platform "${current}" is not a supported target.`);
    process.exit(1);
  }
  stageExtensionsForPlatform(current);
  try {
    runVsce(subcmd, current, extraFlags);
  } finally {
    cleanBundle();
  }
}
