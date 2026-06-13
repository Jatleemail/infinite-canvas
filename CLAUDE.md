# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

无限画布 (infinite-canvas) — an open-source image-creation workbench combining an infinite canvas, AI image/video generation (OpenAI-compatible APIs + Seedance via 火山方舟), a chat assistant tied to canvas selection, and a curated prompt library scraped from GitHub repos.

The project is **pre-1.0 and does not guarantee data compatibility** — DB schemas and storage formats can change without migrations. Canvas projects and "我的素材" are stored in the **browser** (localforage), not in the backend DB.

## Repository Layout

This is a **three-app monorepo**:

- **Backend** (repo root) — Go + Gin + GORM HTTP API at `:8080`. Provides `/api/*`.
- **Frontend** (`web/`) — Next.js 16 App Router + React 19 + AntD 6 + Tailwind v4 + Zustand at `:3000`. Proxies `/api/*` → Go backend via `web/src/app/api/[...path]/route.ts`.
- **Docs site** (`docs/`) — Separate Fumadocs (Next.js) site. Independent `package.json`.

The frontend uses **bun** as package manager (`bun.lock`), not npm/pnpm.

## Common Commands

### Backend (Go)
```bash
go build -o server .           # build the API binary
go run .                       # run dev server (reads .env)
go test ./...                  # run all tests
go test ./service -run TestX   # single test
```

### Frontend (`web/`)
```bash
cd web
bun install
bun run dev                    # next dev on :3000, proxies /api → 127.0.0.1:8080
bun run build                  # next build (standalone output)
bun run start                  # next start
bun run format                 # prettier --write
```

Set `API_BASE_URL` if the Go backend isn't on `http://127.0.0.1:8080`.

### Docs site (`docs/`)
```bash
cd docs
bun install                    # runs fumadocs-mdx postinstall
bun run dev
bun run types:check            # tsc + fumadocs typegen
```

### Docker (full stack)
```bash
# Pulled image
docker-compose up -d
# Local build (Dockerfile multi-stages bun web build + go build, then runs both processes)
docker compose -f docker-compose.local.yml up -d --build
```

The runtime image **starts the Go API on :8080 internally and Next.js on :3000**; only :3000 is exposed. The Next.js proxy route forwards `/api/*` to the Go process.

### Verification policy
Per [AGENTS.md](AGENTS.md): **do not run builds/tests after editing** — the user runs them. Just write the code.

## Architecture

### Backend layering (strict — enforced by AGENTS.md)

```
router/      Route registration only — see router/router.go for the full API surface
middleware/  Auth (UserAuth, AdminAuth, OptionalAuth, NotFoundJSON)
handler/     HTTP I/O only — parse request, call service, respond with OK/Fail/FailError
service/     Business logic, defaults, validation, time/ID/auth handling
repository/  GORM queries only — no business logic
model/       Data structs, enums, simple methods. Shared list-query helpers (model.Query.Normalize, Offset)
config/      Env-driven Config struct via caarlos0/env; godotenv loads .env
```

**Do not bypass layers** (e.g., handler calling repository directly). The response envelope is fixed: `{ code: 0|1, data, msg }` via `handler.OK` / `handler.Fail` / `handler.FailError`. List endpoints reuse `model.Query` + `parseQuery` and tag filtering — follow the existing pattern when adding new list APIs.

DB drivers are selected by `STORAGE_DRIVER` env (`sqlite` default, `mysql`, `postgres`). For MySQL/Postgres the code **auto-creates the target DB** if missing (requires CREATE / CREATEDB grant). `repository/db.go` registers all `AutoMigrate` models — **add new models there** when introducing tables. New tables also require an update to `docs/content/docs/backend/backend-database.mdx`.

Routes are grouped:
- Public: `/api/auth/*`, `/api/settings`, `/api/media/references/:id` (image serving).
- User (JWT via `UserAuth`): `/api/v1/*` — AI generations, edits, chat, audio, video, reference media upload.
- Admin (`AdminAuth`): `/api/admin/*` — users, credit logs, settings, prompts, assets, channel-model tests.
- Prompt-sync scheduler started from `main.go` (`service.StartPromptSyncScheduler` via robfig/cron) periodically pulls prompts from configured GitHub repos.

### Frontend architecture (Next.js App Router)

Route groups:
- `web/src/app/(user)/canvas/` — the main canvas app. Canvas-specific state, hooks, utils, and components all live **inside this directory**; do not promote them globally.
  - `stores/use-canvas-store.ts`, `stores/use-canvas-ui-store.ts` — canvas state.
  - `components/` — flat folder of canvas widgets (`infinite-canvas.tsx`, `canvas-node.tsx`, popovers, dialogs, toolbars, prompt panels, assistant panel).
  - `utils/` — canvas-export, image-data, node-size, resource-references.
- `web/src/app/(admin)/admin/` — admin console. Page-private components live under each page's own `components/` (e.g. `admin/assets/components/`), **not** in a shared `admin/components/`.
- `web/src/app/api/[...path]/route.ts` — the Next.js → Go proxy.
- `web/src/app/webdav-proxy/` — WebDAV sync passthrough.

Cross-cutting modules:
- `web/src/services/api/` — **all HTTP calls live here** (admin, assets, audio, auth, image, prompts, request, video). Don't fetch from components directly.
- `web/src/services/` (root) — `app-sync.ts`, `webdav-sync.ts`, `file-storage.ts`, `image-storage.ts` (localforage wrappers).
- `web/src/stores/` — **global** Zustand stores only: `use-asset-store`, `use-config-store`, `use-theme-store`, `use-user-store`. Canvas state stays in the canvas folder.
- `web/src/hooks/` — only shared hooks (copy-with-toast, download-with-toast, unified confirm modal, etc.). Page-private hooks colocate with the page.
- `web/src/lib/app-theme.ts` — admin theme tokens / shadows / table colors. Page components must not write their own `dark ? ...` branches.

### Persistence boundary

- **Backend DB** stores: users, credits/credit-logs, prompts, prompt categories, admin-curated assets, system settings.
- **Browser (localforage)** stores: canvas projects, "我的素材", generated images, base64 blobs, AI API keys (sent directly from the browser to OpenAI-compatible endpoints). Use `localforage`, **not** `localStorage`, for any non-trivial data.

## Canvas UI conventions (strict)

Canvas widgets must consume `canvasThemes`, `useThemeStore`, or AntD `ConfigProvider` tokens — **never hardcode** `stone`/`slate`/black/white colors, since that breaks the light/dark theme. The canvas top toolbar and status info use a deliberately **flat, borderless, shadowless** style (no capsule backgrounds) — match it when adding new canvas chrome. Image node sizing must respect original aspect ratio unless the feature explicitly needs free-transform.

## Component-style rules to know before editing the frontend

These are the rules in [AGENTS.md](AGENTS.md) most likely to cause review churn — internalize them:

- **No pass-through components** (`return <X>{children}</X>`). Inline the real component.
- **No prop drilling for global state.** If something is in a global store/hook, consume it where it's used.
- **Don't extract a `Manager` component** when the page has only one main business component — write it in `page.tsx`.
- Prefer **Tailwind classNames** for component-private styles; keep `globals.css` minimal (variables, resets, third-party overrides only).
- AntD code: when in doubt about a component's API, check https://ant.design/llms-full.txt and match the project's antd 6 usage.
- Icons: prefer `lucide-react` or existing AntD icons.
- UI copy stays in Chinese.

## Release process

Per [AGENTS.md](AGENTS.md):
1. Move `CHANGELOG.md` `## Unreleased` items into a new version section (keep an empty `Unreleased` header).
2. Bump the version in the root `VERSION` file.
3. Commit all pending changes.
4. Tag the commit with the new version (e.g. `v0.2.6`).
5. **Do not** run builds or tests as part of release unless asked.

## Documentation rules

- `README.md` stays minimal (intro + quick start + doc links).
- `docs/index.md` is the AI-facing index — keep it out of `docs/content/docs/`.
- New backend tables → update `docs/content/docs/backend/backend-database.mdx`.
- New features go through this lifecycle:
  `progress/todo.mdx` → (when implemented) `progress/pending-test.mdx` → (when user confirms) `overview/features.mdx`. Do not skip straight to `features.mdx`.
- `CHANGELOG.md` `Unreleased` is the **version-level summary**, not a copy of `pending-test.mdx`.
- Don't date docs unless the user explicitly asks for a timestamp.

## When changing schemas / data shapes

Since the project doesn't guarantee history compatibility, **don't add migration shims, old-field fallbacks, or drop-old-table cleanup code** unless the user asks. Just update the new shape.
