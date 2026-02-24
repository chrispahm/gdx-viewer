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
		external: [
			'bufferutil',
			'utf-8-validate',
			'@duckdb/node-api',  // Native addon cannot be bundled
		],
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
