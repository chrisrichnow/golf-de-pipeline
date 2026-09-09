# Fairway — Codex Dashboard Version

**Preserved:** 2026-09-09 at Chris's request.

Chris likes this dashboard and wants to retain it while asking Claude to build a separate version. This folder is the preserved Codex baseline. Do not redesign or overwrite it as part of the Claude comparison; put that work in `dashboard-claude/` or another separate folder.

The six original source files are exact copies of the working `dashboard/` implementation. `SHA256.json` records their verified SHA-256 hashes. `previews/` contains the desktop, mobile, and player-view screenshots captured during browser verification. The original `dashboard/` remains unchanged.

## Open this version

From the golf project directory, **PowerShell**:

```powershell
.\.venv\Scripts\python.exe dashboard-codex/server.py --port 8051
```

Then open http://localhost:8051. The original working dashboard uses http://localhost:8050. Reserve a different port, such as 8052, for Claude's version.

This copy uses the project's existing virtual environment, `.env`, and Postgres analytics tables. It is a preserved application version, not a frozen database backup; future pipeline loads will appear when refreshed. No credentials are copied here. Run it through Python, not by opening the HTML directly.

## Preserved features and verification

- Overview metrics, wins/top-ten charts, searchable/sortable/paginated season leaderboard.
- Individual and team tournament leaderboards, with team scores kept separate.
- Player selection, season statistics, finish-history chart, and tournament drilldowns.
- Filtered CSV export, refresh from Postgres, responsive layout, and recoverable error state.
- Browser verification passed during the build; all six saved source files were hash-checked against the working version during preservation.

Project history: `../PROGRESSION.md`, `../session-summary-2026-09-09.md`, and `../README.md`.
