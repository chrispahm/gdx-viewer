/**
 * Download DuckDB extensions (excel + gdx) for all supported platforms.
 *
 * Downloads pre-built .duckdb_extension files from DuckDB's CDN so they can be
 * bundled into the VSIX for offline use (corporate firewalls, air-gapped machines).
 *
 * Usage:
 *   node scripts/download-extensions.js
 */

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { createGunzip } = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "duckdb-extensions");
const DUCKDB_DIR = path.join(ROOT, "node_modules", "@duckdb");

// VS Code target → DuckDB platform name
const PLATFORM_MAP = {
  "darwin-arm64": "osx_arm64",
  "darwin-x64": "osx_amd64",
  "linux-x64": "linux_amd64",
  "win32-x64": "windows_amd64",
};

// Extensions to download: [name, baseUrl]
const EXTENSIONS = [
  ["excel", "https://extensions.duckdb.org"],
  ["gdx", "https://community-extensions.duckdb.org"],
];

function getDuckDBVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(DUCKDB_DIR, "node-bindings", "package.json"),
      "utf8"
    )
  );
  // Strip -r.X suffix: "1.4.4-r.1" → "1.4.4"
  return pkg.version.replace(/-r\.\d+$/, "");
}

async function downloadAndDecompress(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  // Pipe through gunzip → file
  const gunzip = createGunzip();
  const fileStream = fs.createWriteStream(destPath);

  // Convert web ReadableStream to Node stream
  const { Readable } = require("stream");
  const nodeStream = Readable.fromWeb(res.body);

  await pipeline(nodeStream, gunzip, fileStream);
}

async function main() {
  const version = getDuckDBVersion();
  console.log(`DuckDB version: ${version}`);

  // Clean and recreate output directory
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }

  const duckdbPlatforms = Object.values(PLATFORM_MAP);

  // Create platform directories
  for (const platform of duckdbPlatforms) {
    fs.mkdirSync(path.join(OUT_DIR, platform), { recursive: true });
  }

  // Download all extensions for all platforms
  for (const [extName, baseUrl] of EXTENSIONS) {
    for (const platform of duckdbPlatforms) {
      const url = `${baseUrl}/v${version}/${platform}/${extName}.duckdb_extension.gz`;
      const destPath = path.join(
        OUT_DIR,
        platform,
        `${extName}.duckdb_extension`
      );

      process.stdout.write(`  ${extName} / ${platform} ... `);
      try {
        await downloadAndDecompress(url, destPath);
        console.log("OK");
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // Write version.json
  const versionFile = path.join(OUT_DIR, "version.json");
  fs.writeFileSync(
    versionFile,
    JSON.stringify({ duckdbVersion: version }, null, 2) + "\n"
  );
  console.log(`\nWrote ${versionFile}`);
  console.log("Done — all extensions downloaded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
