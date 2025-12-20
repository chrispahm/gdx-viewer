/**
 * DuckDB WASM Worker Entry Point
 * 
 * This wrapper sets up Web Worker globals that the duckdb-wasm worker expects,
 * then loads the bundled worker. This file is required by worker_threads.
 */

const { parentPort } = require('worker_threads');

// Set up Web Worker compatible globals expected by duckdb-wasm
global.self = global;
global.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);

global.addEventListener = (type, handler) => {
  if (type === 'message') {
    parentPort.on('message', (msg) => handler({ data: msg }));
  }
};

Object.defineProperty(global, 'onmessage', {
  set: (handler) => {
    parentPort.on('message', (msg) => handler && handler({ data: msg }));
  },
  get: () => null,
});

// Load the bundled duckdb worker
require('./duckdb-node-eh.bundled.worker.cjs');
