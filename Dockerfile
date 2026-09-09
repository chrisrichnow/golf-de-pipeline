FROM apache/airflow:2.10.4-python3.11
RUN pip install --no-cache-dir "apache-airflow==2.10.4" "python-dotenv==1.0.1" \
    --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-2.10.4/constraints-3.11.txt"
