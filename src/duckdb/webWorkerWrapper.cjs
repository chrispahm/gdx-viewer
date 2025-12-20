/**
 * DuckDB Worker Wrapper using web-worker package
 * 
 * This wrapper is bundled during the build process to create a self-contained
 * worker that properly emulates the Web Worker API in Node.js.
 * 
 * The key insight is that web-worker package properly sets up WorkerGlobalScope
 * which is required for duckdb-wasm's async worker communication to work efficiently.
 */

// Re-export web-worker as the default export so it can be used directly
// This will be bundled together with duckdb-node-eh.worker.cjs
const WebWorker = require('web-worker');
module.exports = WebWorker;
