# GDX Viewer

VS Code custom editor for exploring GAMS `.gdx` files. It uses DuckDB-WASM + the `duckdb_gdx` extension to read symbols, preview data, run ad-hoc SQL, and export results.

![GDX Viewer Screenshot](/media/gdx-viewer.gif)

## Features

- Open `.gdx` files in a custom editor with an interactive data grid.
- Symbols tree: browse symbols, see dimensions and record counts.
- One-click paging: quickly page through symbol data (`LIMIT/OFFSET`).
- SQL panel: expand to run arbitrary queries against the currently opened GDX (uses `read_gdx`).
- Display attributes: control numeric formatting (precision, format, squeeze defaults/zeros).
- Export menu: export the current query result to CSV, Excel (`xlsx`), or Parquet via DuckDB `COPY`.
- Automatic filter preloading is supported via background domain loading.

## Requirements

- VS Code 1.106.1 or newer.

## Usage

1. Open a `.gdx` file in VS Code; the GDX Viewer custom editor will appear.
2. Select a symbol from the Symbols view; the first page (100 rows) is shown automatically.
3. Use paging controls in the grid to move through the data.
4. Open the SQL panel to run custom queries (Ctrl/Cmd+Enter to run). The placeholder `__GDX_FILE__` is automatically replaced.
5. Use the Attributes button to adjust formatting.
6. Use Export → CSV/Excel/Parquet to write the current query to disk. The extension installs/loads DuckDB’s `excel` extension automatically for XLSX output.

## Extension Settings

- `gdxViewer.autoLoadFilters` (boolean, default: true) — Automatically load filter/domain values for the selected symbol in the background.

## Development

- Install dependencies: `npm install`
- Build: `npm run compile`
- Watch build: `npm run watch`
- Run tests: `npm test` (compiles tests and launches VS Code test runner)

## Known Issues

- Large GDX files may still be slow to scan depending on environment; paging and filter loading run lazily to reduce perceived latency.

## License

MIT
