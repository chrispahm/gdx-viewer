/**
 * Server Entry Point
 * 
 * This file is the entry point when the server is spawned as a child process.
 * It reads the extension path from command line args and starts the server.
 */

import { GdxServer } from './gdxServer';

interface ServerStartupOptions {
  allowRemoteSourceLoading?: boolean;
}

async function main() {
  const extensionPath = process.argv[2];
  const optionsArg = process.argv[3];
  if (!extensionPath) {
    console.error('[GDX Server] Missing extension path argument');
    process.exit(1);
  }

  let startupOptions: ServerStartupOptions = {};
  if (optionsArg) {
    try {
      startupOptions = JSON.parse(optionsArg) as ServerStartupOptions;
    } catch (error) {
      console.warn('[GDX Server] Failed to parse startup options:', error);
    }
  }

  const server = new GdxServer(extensionPath, {
    allowRemoteSourceLoading: startupOptions.allowRemoteSourceLoading ?? false,
  });

  try {
    const port = await server.start();

    // Send port back to parent process
    if (process.send) {
      process.send({ type: 'ready', port });
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
