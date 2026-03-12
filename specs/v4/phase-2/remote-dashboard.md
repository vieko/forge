---
depends: [http-api.md]
---

# Remote Dashboard

## Outcome

A web-based status viewer shows what `forge status`, `forge specs`, and `forge stats` display but in a browser. It is a static HTML + JS + CSS page served by the HTTP State API, with live updates via SSE. Accessible from any device on the local network — phone, tablet, or another machine.

## Acceptance Criteria

- Single-page web dashboard showing: recent runs, spec lifecycle status, aggregate stats, active pipelines, running tasks
- Static HTML + JS + CSS with zero build step (no framework, no bundler, no npm dependencies)
- Talks to the HTTP State API endpoints (`/runs`, `/specs`, `/pipelines`, `/sessions`, `/tasks`)
- Live updates via SSE connection to `/events` — dashboard auto-refreshes when state changes
- Pipeline view shows stages, gates, costs, and current progress (mirrors TUI pipeline tab)
- Served by `forge serve` at the root path (`GET /`)
- Accessible from any device on the local network via `http://<host>:<port>/`

## Context

- Relevant files: `src/serve.ts` (HTTP API from http-api.md), `src/display.ts` (ASCII display patterns for reference)
- New files: `static/index.html`, `static/app.js`, `static/style.css` — served as static assets by `Bun.serve`
- The dashboard is a read-only viewer — it does not trigger actions or mutate state
- Design should be responsive (usable on phone screens)
- Use semantic HTML and CSS grid/flexbox for layout — no CSS framework
- SSE reconnection: auto-reconnect on connection drop with exponential backoff
- Consider using the same color scheme as the terminal output (dark background, green/red/yellow status colors)
