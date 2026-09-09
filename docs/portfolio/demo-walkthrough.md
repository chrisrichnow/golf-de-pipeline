# Two-minute project demo

## Before presenting

Start Docker Desktop, the golf Postgres service, and the dashboard. Use existing data; the demo does not need API requests.

**PowerShell, from the project root:**

```powershell
docker compose up -d postgres-golf
.\.venv\Scripts\python.exe dashboard/server.py
```

Open http://localhost:8050. If that port is already running, use the existing page.

## Walkthrough

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Overview metrics and top-ten chart | “This dashboard sits on top of a golf data pipeline. The loaded dataset covers 37 events and 572 players, with player and team records kept separate.” |
| 0:20–0:40 | Switch the chart from top tens to wins, then select a player | “The analytics layer supports season summaries and individual tournament histories. It uses player IDs rather than names as keys.” |
| 0:40–1:00 | Player finish-history chart; click a tournament | “The dashboard reads structured tables built from raw JSON. Ties and withdrawals retain their original labels, while numeric fields support sorting and analysis.” |
| 1:00–1:20 | Select Zurich Classic in Tournaments | “This event reports team scores, so those results have their own table and do not inflate individual player wins.” |
| 1:20–1:40 | README architecture diagram | “Python extracts the data, Postgres stores the raw source, SQL builds analytics, and Airflow runs the steps in order.” |
| 1:40–2:00 | `sql/quality_checks.sql` and test results | “Completed-event checkpoints make ingestion resumable. Seven checks run before publishing analytics; a failed rebuild rolls back. Ten tests cover ingestion and transformation behavior.” |

## Recorded preview

[Watch the short dashboard preview](dashboard-demo.webm). This is a silent UI preview of real database results, not a recording of the two-minute narrated walkthrough or of a pipeline run.

To regenerate it with the dashboard running and browser dependencies installed:

```powershell
npm.cmd run demo:record
```

## Likely follow-up questions

**Why retain raw JSON?** It lets the pipeline reprocess original source values when transformation requirements change, without spending more API requests.

**How do you avoid duplicates?** A completed tournament has a checkpoint committed in the same transaction as its raw rows. Backfills skip those events, and analytics includes only completed checkpoint snapshots. Independent demonstration inserts are append-only and excluded from analytics.

**What happens if cleaning fails?** The analytics rebuild and checks share one transaction. Failure rolls back the derived changes and leaves the previous analytics available.

**What would you do next?** Materialize round-level analytics if repeated round queries need it; add source-correction handling and deployment only when there is a real use case. Those are extensions, not current capabilities.
