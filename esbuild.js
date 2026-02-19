const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

// Copy DuckDB WASM payload used by the bundled worker
function copyDuckdbWasm() {
	const runtimeSrcDir = path.join(__dirname, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
	const runtimeDestDir = path.join(__dirname, 'dist', 'duckdb');

	fs.mkdirSync(runtimeDestDir, { recursive: true });

	fs.copyFileSync(
		path.join(runtimeSrcDir, 'duckdb-eh.wasm'),
		path.join(runtimeDestDir, 'duckdb-eh.wasm')
	);

	// Copy the static worker entry wrapper
	fs.copyFileSync(
		path.join(__dirname, 'src', 'duckdb', 'duckdb-worker-entry.cjs'),
		path.join(runtimeDestDir, 'duckdb-worker-entry.cjs')
	);

	console.log('[build] Copied DuckDB wasm');
}

// Bundle the DuckDB node worker (and its JS deps) to avoid shipping node_modules
async function bundleDuckdbWorker() {
	const runtimeSrcDir = path.join(__dirname, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
	const entry = path.join(runtimeSrcDir, 'duckdb-node-eh.worker.cjs');
	const outdir = path.join(__dirname, 'dist', 'duckdb');

	fs.mkdirSync(outdir, { recursive: true });

	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: path.join(outdir, 'duckdb-node-eh.bundled.worker.cjs'),
		target: ['node18'],
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		// bufferutil/utf-8-validate are optional native deps for ws; mark external so build succeeds without them
		external: ['bufferutil', 'utf-8-validate'],
		banner: {
			js: "const path = require('path');",
		},
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	console.log('[build] Bundled DuckDB worker');
}

// Bundle web-worker package as a standalone module for proper Node.js Worker emulation
async function bundleWebWorker() {
	const outdir = path.join(__dirname, 'dist', 'duckdb');

	fs.mkdirSync(outdir, { recursive: true });

	await esbuild.build({
		entryPoints: ['node_modules/web-worker/dist/node/index.cjs'],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: path.join(outdir, 'web-worker.bundled.cjs'),
		target: ['node18'],
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	console.log('[build] Bundled web-worker');
}

// Build CSS with Tailwind
function buildCss() {
	fs.mkdirSync(path.join(__dirname, 'dist/webview'), { recursive: true });
	execSync(
		`npx tailwindcss -i src/webview/styles.css -o dist/webview/index.css ${production ? '--minify' : ''}`,
		{ stdio: 'inherit' }
	);
	console.log('[build] Built CSS');
}

async function main() {
	// Copy WASM files first
	// copyWasmFiles();
	copyDuckdbWasm();
	await bundleDuckdbWorker();

	// Build CSS
	buildCss();

	// Build extension
	const extensionCtx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// Build webview
	const webviewCtx = await esbuild.context({
		entryPoints: [
			'src/webview/index.tsx'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'dist/webview/index.js',
		jsx: 'automatic',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
		// Ignore CSS imports - we build CSS separately with Tailwind
		external: ['*.css'],
	});

	// Build server (runs in child process, bypasses extension host)
	const serverCtx = await esbuild.context({
		entryPoints: [
			'src/server/serverEntry.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/server.js',
		external: ['bufferutil', 'utf-8-validate'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), webviewCtx.watch(), serverCtx.watch()]);
	} else {
		await extensionCtx.rebuild();
		await webviewCtx.rebuild();
		await serverCtx.rebuild();
		await extensionCtx.dispose();
		await webviewCtx.dispose();
		await serverCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
