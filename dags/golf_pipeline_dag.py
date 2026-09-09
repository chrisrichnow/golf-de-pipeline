"""Weekly completed-event ingestion followed by checked SQL analytics."""
from datetime import timedelta

import pendulum
from airflow.decorators import dag, task


@dag(
    dag_id="golf_pipeline",
    schedule="0 8 * * 2",
    start_date=pendulum.datetime(2026, 9, 1, tz="America/Chicago"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=True,
    default_args={"retries": 0, "execution_timeout": timedelta(minutes=20)},
    tags=["golf", "data-engineering"],
    doc_md="Completed PGA Tour events -> raw Postgres -> checked player/team analytics. "
           "Runs Tuesdays at 8am Central while Docker is running; capped at 10 API requests per run.",
)
def golf_pipeline():
    @task
    def ingest_completed_events():
        from pipeline import ingest
        # Refresh cached schedule weekly to capture event changes. Completed
        # checkpoints still skip leaderboard requests. No blind API retries.
        ingest(year=2026, max_requests=10, refresh_schedule=True)

    @task
    def build_analytics():
        from pipeline import transform
        return transform()

    ingest_completed_events() >> build_analytics()


golf_pipeline()
