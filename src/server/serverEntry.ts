/**
 * Server Entry Point
 * 
 * This file is the entry point when the server is spawned as a child process.
 * It reads the extension path from command line args and starts the server.
 */

import { GdxServer } from './gdxServer';

async function main() {
  const extensionPath = process.argv[2];
  if (!extensionPath) {
    console.error('[GDX Server] Missing extension path argument');
    process.exit(1);
  }

  const server = new GdxServer(extensionPath);

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
