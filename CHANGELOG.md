# Change Log

All notable changes to the "gdx-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2025-12-20

### Added
- **WebSocket Server Architecture**: DuckDB now runs in a separate child process, bypassing VS Code extension host resource limitations
- **Reset Filters button**: Toolbar button to clear all filters, only visible when filters are active
- **Count query caching**: Avoids redundant COUNT queries when paginating or sorting

### Changed
- **Improved query performance**: First query now completes much faster for large files
- **Faster UI response**: Loading overlay now appears immediately when triggering queries
- **Reduced default page size**: Changed from 10,000 to 1,000 rows for better responsiveness

### Fixed
- Server startup timeout issues with VS Code debugger inspector conflicts
- Query execution blocking the UI thread

## [0.0.9] - 2025-12-20

### Changed
- Updated extension icon

## [0.0.8] - 2025-12-20

### Added
- Extension icon

## [0.0.7] - 2025-12-20

### Fixed
- Filters not filtering all data correctly

## [0.0.6] - 2025-12-20

### Added
- Animated GIF in README
- License file

## [0.0.5] - 2025-12-20

### Added
- Custom editor for GDX files
- Symbol tree view in Explorer sidebar
- Data table with filtering and sorting
- SQL query editor
- Export to CSV, Excel, and Parquet
- Display attributes panel (squeeze defaults, formatting options)