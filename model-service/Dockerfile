FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps for pandas/psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# App
COPY app/ /app/
# Model artifacts (mount or bake in)
# COPY models/model.pkl /models/model.pkl
# COPY models/model.meta.json /models/model.meta.json

ENV MODEL_PATH=/models/model.pkl \
    META_PATH=/models/model.meta.json \
    MODEL_ID=1 \
    REPORTER_DEFAULT=RWA \
    LOG_LEVEL=INFO

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
