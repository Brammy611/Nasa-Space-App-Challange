# AGNIBHUMI Python processing API (FastAPI). See ../DEPLOY.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./
COPY fire_pipeline ./fire_pipeline
# Generated offline stores (see ../DEPLOY.md "File data"). The archive is shipped gzipped
# (~29 MB instead of ~118 MB, under GitHub's 100 MB per-file limit) and unpacked here.
#   data/historical.sqlite.gz     (scripts/build_historical_store.py, then: gzip -9 -k)
#   data/admin_boundaries.sqlite  (scripts/build_admin_boundaries.py)
# Both files are optional: if they are missing the API still starts, but the historical
# calendar and kecamatan lookup are unavailable. data/.gitkeep keeps the folder in Git.
COPY data/ ./data/
RUN if [ -f ./data/historical.sqlite.gz ]; then gunzip -f ./data/historical.sqlite.gz; fi

EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:' + __import__('os').environ.get('PORT', '8000') + '/api/health')"
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
