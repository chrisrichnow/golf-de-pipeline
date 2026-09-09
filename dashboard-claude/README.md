# Clubhouse — golf warehouse dashboard

A read-only browser over the `golf_data` warehouse. Built as an independent
comparison build; it does not share code with `dashboard/` or `dashboard-codex/`,
and it runs on its own port so all three can be open at once.

**Port 8052.** The database is never written to.

## Run it

Postgres must be up (`docker compose ps` — the `postgres-golf` container).
Airflow is not needed to browse data that is already loaded.

```powershell
.\.venv\Scripts\python.exe dashboard-claude\server.py
```

Then open <http://127.0.0.1:8052>. Ctrl+C in that terminal stops it.

Browser check — drives every view in Edge, fails on any console error, and
writes screenshots to `dashboard-claude/shots/`:

```powershell
node dashboard-claude\check.cjs
```

## What it shows

| View | What you get |
|---|---|
| **Overview** | Headline counts, how the raw → ops → analytics layers stack up, season coverage against the cached schedule, outcome mix, and field size across the season |
| **Tournaments** | All 37 loaded events — course, purse, field, cut line, winner. Click any row for the full leaderboard with round-by-round scores, plus team results where the event had them |
| **Players** | All 572 players with season totals and scoring average. Click for a player card: finishes across the season and every event with round scores |
| **Scoring** | The round grain — average to par by round number, the distribution of individual round scores, course difficulty, and the lowest rounds of the year |
| **Pipeline** | Load state for all 49 scheduled events, live quality checks, tournament checkpoints, and the ingestion runs behind them |

## Design decisions

**Read-only by construction.** Every query runs inside a `READ ONLY`
transaction (`warehouse.py`). The dashboard creates no tables, views, or
functions — the warehouse is treated as a published artifact, so running this
can never change what the pipeline produced.

**The round grain comes from raw JSONB.** `analytics.player_results` stops at
one row per player per event. Round-by-round scores, course names, purses and
cut lines only exist inside the stored API payload, so the Scoring view unnests
`payload -> player -> rounds` at query time — 13,430 round records that the
analytics tables never flattened. That is the single biggest thing this
dashboard surfaces that a straight read of the analytics tables would miss.
The natural next pipeline step is materializing that as
`analytics.round_results`; doing it from here would mean writing to the
database, which this deliberately does not do. Cost of unnesting live is about
80 ms, so a short in-process TTL cache is enough.

**Coverage is explained, not just counted.** The schedule lists 49 events and
37 are loaded. Rather than showing that as a 76% gap, the Pipeline view splits
the remainder into *not yet played* and *played but missing* — as of the last
load, all twelve are simply future events. A coverage number without that split
would read as a broken pipeline.

**Counts that disagree are shown side by side.** The checkpoint row count and
the published analytics count appear as separate columns, so a transform that
silently dropped rows would be visible instead of hidden behind one total.

**37 events but 36 tournaments.** The Zurich Classic is a team event: it has 74
team rows and no individual rows. Both numbers appear on the Overview rather
than picking one, because the difference is the point — team scores are kept out
of individual win totals on purpose.

**Colour carries one job each.** Sequential blue for magnitude (field size,
scoring distribution); a blue↔red diverging scale for course difficulty, where
the polarity is real (under par vs over par); categorical hues only for the
outcome mix, where the categories are the subject. The categorical set was
checked with the data-viz palette validator for colourblind separation and
contrast in both light and dark mode. Note that difficulty maps *harder → red*,
which is the data-viz reading, not the golf-leaderboard convention where red
means under par — the axis is labelled to avoid the ambiguity.

**No chart gates its values.** Every chart has a table-view toggle, tooltips are
keyboard reachable, and dark mode is a selected palette rather than an inverted
one.

## Files

```
server.py     HTTP server, routing, JSON API, TTL cache
warehouse.py  every SQL query, read-only connection pool
check.cjs     Playwright browser check
static/       index.html · styles.css · app.js  (no framework, no CDN)
shots/        screenshots written by check.cjs
```

Dependencies are `psycopg2` and `python-dotenv`, both already in the project's
`requirements.txt`. The frontend loads nothing from the internet — charts are
hand-drawn SVG — so it works offline and has no supply-chain surface. Static
files are served from a fixed allowlist, so `.env` and project files are not
reachable through the server.

## Caveats

- Season totals describe **this dataset's loaded events**, not an official PGA
  statistics feed.
- Scoring averages mix courses and round counts, so they are not directly
  comparable performance ratings. Course difficulty in particular reflects the
  weather and setup of the one week each course was played.
- Round 3 and 4 averages only include players who made the cut, which is why the
  weekend scoring average looks lower. The Scoring view says so on the chart.
