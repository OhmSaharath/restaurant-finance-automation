import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.api.v1.analytics import router as analytics_router
from app.api.v1.billing import router as billing_router
from app.api.v1.costs import router as costs_router
from app.api.v1.gmail_ingestion import router as gmail_ingestion_router
from app.api.v1.ingestion import router as ingestion_router
from app.api.v1.loyverse import router as loyverse_router
from app.api.v1.menu_items import router as menu_items_router
from app.api.v1.menu_sales import router as menu_sales_router
from app.core.config import settings
from app.core.database import get_supabase_client
from app.core.rate_limit import limiter
from app.ingestion.resolver import warm_cache_from_db

# Explicit console logging at INFO: without this the `ingestion_audit` logger
# (used by ingestion.py / gmail_ingestion.py) has no handler, so all the deep
# `[INGEST DEBUG]` / `[RESOLVER DEBUG]` / audit lines are silently dropped.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
    force=True,
)

# Initialize slowapi rate limiter (in-memory). The singleton lives in
# app/core/rate_limit.py so route modules can apply explicit per-route limits
# against the SAME instance that main.py binds to app.state.limiter.
# (limiter built by import above)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Lifespan context manager for startup cache warming and shutdown cleanups."""
    # Pre-warm store resolver cache from database if connected
    try:
        warmed_count = warm_cache_from_db()
        print(f"[*] Ingestion pipeline initialized. Cached {warmed_count} store mappings.")
    except Exception as e:
        print(f"[!] Warning: Failed to pre-warm store cache on startup: {e}")
    yield


app = FastAPI(
    title="Finance Delivery Ingestion & Settlement API",
    description="Multi-tenant automated financial ingestion, Recipe BOM, and reconciliation platform for food delivery systems (Grab, LINE MAN, Shopee Food, Robinhood).",
    version=settings.VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc"
)

# Attach slowapi rate limiter state and middleware
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


# Global Exception Handlers
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "HTTP_ERROR", "message": str(detail)}
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": "VALIDATION_ERROR",
            "message": "Invalid request schema or payload parameter.",
            "details": exc.errors()
        }
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logging.getLogger("ingestion_audit").exception(
        "Unhandled server error on %s %s", request.method, request.url.path
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "INTERNAL_SERVER_ERROR",
            "message": "An unexpected internal server error occurred."
        }
    )


# Health Check Endpoints
@app.get("/health", tags=["Health"], summary="Health Check")
@app.get("/api/v1/health", tags=["Health"], summary="API v1 Health Check")
async def health_check() -> dict:
    db_status = "connected" if get_supabase_client() is not None else "offline/local"
    return {
        "status": "healthy",
        "project": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
        "database": db_status
    }


# Include Routers
app.include_router(ingestion_router, prefix="/api/v1")
app.include_router(loyverse_router, prefix="/api/v1")
app.include_router(gmail_ingestion_router, prefix="/api/v1")
app.include_router(analytics_router, prefix="/api/v1")
app.include_router(billing_router, prefix="/api/v1")
app.include_router(costs_router, prefix="/api/v1")
app.include_router(menu_items_router, prefix="/api/v1")
app.include_router(menu_sales_router, prefix="/api/v1")
