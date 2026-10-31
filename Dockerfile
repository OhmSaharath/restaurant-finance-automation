# finance-delivery FastAPI backend (Cloud Run).
#
# Cloud Run injects PORT (default 8080); uvicorn binds $PORT. A long-running
# host is required — the Gmail sync worker (message loop + throttle) and the
# Pub/Sub BackgroundTasks receiver must NOT run on short-lived serverless (that
# is why FastAPI lives on Cloud Run, not Vercel).
FROM python:3.12-slim

# Avoid .pyc bytecode + buffered stdout (so Cloud Run logs stream, not stall).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Layer deps first so code edits don't invalidate the pip cache layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application + schema packages only (web/, docs/, tests/, samples/
# are NOT part of the backend runtime image).
COPY app ./app
COPY schemas ./schemas

# Run as a non-root user for a smaller blast radius.
RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 8080

# Bind 0.0.0.0:$PORT (Cloud Run sets PORT). Default 8080 for local parity.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]