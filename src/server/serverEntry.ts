/**
 * Server Entry Point
 *
 * This file is the entry point when the server is spawned as a child process.
 * It reads startup options from command line args and starts the server.
 */

import { GdxServer } from './gdxServer';

interface ServerStartupOptions {
  allowRemoteSourceLoading?: boolean;
  globalStoragePath?: string;
}

async function main() {
  const t0 = performance.now();
  const elapsed = () => `${(performance.now() - t0).toFixed(0)}ms`;

  console.log(`[GDX Server] [${elapsed()}] Starting server entry...`);

  // First arg is extensionPath (kept for backward compat, unused by server)
  // Second arg is JSON startup options
  const optionsArg = process.argv[3] ?? process.argv[2];

  let startupOptions: ServerStartupOptions = {};
  if (optionsArg) {
    try {
      startupOptions = JSON.parse(optionsArg) as ServerStartupOptions;
    } catch (error) {
      console.warn('[GDX Server] Failed to parse startup options:', error);
    }
  }

  console.log(`[GDX Server] [${elapsed()}] Creating GdxServer`);
  const server = new GdxServer({
    allowRemoteSourceLoading: startupOptions.allowRemoteSourceLoading ?? false,
    globalStoragePath: startupOptions.globalStoragePath,
  });

  try {
    console.log(`[GDX Server] [${elapsed()}] Calling server.start()...`);
    const port = await server.start();
    console.log(`[GDX Server] [${elapsed()}] Server started on port ${port}`);

    // Send port back to parent process
    if (process.send) {
      process.send({ type: 'ready', port });
      console.log(`[GDX Server] [${elapsed()}] Sent ready message to parent`);
    }

    // Handle shutdown signals
    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      await server.stop();
      process.exit(0);
    });

    // Keep process alive
    process.stdin.resume();

  } catch (error) {
    console.error('[GDX Server] Failed to start:', error);
    process.exit(1);
  }
}

main();
