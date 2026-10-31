# Architecture

## Runtime components

### Next.js web application

The `web/` application renders the authenticated product interface and exposes server-side route handlers. Browser code uses the public Supabase client, while operations requiring privileged credentials remain in server-only modules and routes.

### FastAPI service

The `app/` service handles settlement ingestion, parsing, normalization, Gmail push events, Loyverse synchronization, reconciliation, and analytics APIs. It is packaged with Docker and designed for Google Cloud Run because the ingestion pipeline includes longer-running work and Pub/Sub-triggered processing.

### Supabase

Supabase provides PostgreSQL, authentication, and storage. Tenant membership is represented by brand-user relationships, while Row Level Security constrains user-facing access to the brands a user belongs to. Server-side integration and billing workflows use privileged credentials that must never be bundled into client JavaScript.

## Main data flows

### Settlement reports

1. A report is uploaded directly or discovered through Gmail.
2. The backend selects the appropriate parser for the platform and file type.
3. Branch and menu identities are normalized against tenant-scoped mappings.
4. Daily financial and item-level records are upserted into Supabase.
5. Next.js dashboards read tenant-authorized aggregates and reconciliation results.

### Gmail automation

1. A user connects Google through OAuth.
2. Refresh tokens are encrypted before server-side storage.
3. Gmail watch notifications are delivered through Google Pub/Sub.
4. The backend validates the push request, retrieves new messages, and processes supported attachments idempotently.

### Loyverse synchronization

1. A tenant configures a Loyverse integration and branch mapping.
2. Manual or scheduled sync retrieves receipts, item metadata, and configured costs.
3. In-store sales are normalized into the same daily and item-level reporting model as delivery-platform data.

## Deployment model

- `web/`: Next.js deployment on Vercel.
- repository root: Dockerized FastAPI deployment on Google Cloud Run.
- `supabase/migrations/`: schema changes applied through a reviewed Supabase migration workflow.
- Google Cloud Scheduler: authenticated trigger for scheduled Loyverse synchronization.

Environment variables are configured separately for Vercel and Cloud Run. Local `.env` files, Vercel linkage metadata, Supabase project references, and production exports are intentionally excluded from version control.
