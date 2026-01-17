# kasmproxy

SSL/WS proxy: HTTP(S) to HTTPS WebSocket bridge for Kasm workspaces.

## Configuration

Environment variables:
- `TARGET_HOST` (default: `localhost`) - Target host to proxy requests to
- `TARGET_PORT` (default: `6901`) - Default target port for proxied requests
- `LISTEN_PORT` (default: `80`) - Port for kasmproxy to listen on
- `VNC_PW` (optional) - VNC password for HTTP basic auth (username: `kasm_user`, password: `VNC_PW`)

## Routing Constraints

### /ssh → Port 9999 (ttyd Terminal)

Requests to `/ssh` are routed to port **9999** with the `/ssh` prefix stripped:
- `/ssh` → routes to `localhost:9999/`
- `/ssh/` → routes to `localhost:9999/`
- `/ssh/nested/path` → routes to `localhost:9999/nested/path`
- `/ssh?id=123` → routes to `localhost:9999/?id=123`

Protocol: Plain HTTP

### /files → Port 9998 (File Manager)

Requests to `/files` are routed to port **9998** with the `/files` prefix stripped:
- `/files` → routes to `localhost:9998/` (HTML page)
- `/files/` → routes to `localhost:9998/` (HTML page)
- `/files/js/app.js` → routes to `localhost:9998/js/app.js` (JavaScript asset)
- `/files/css/style.css` → routes to `localhost:9998/css/style.css` (CSS asset)

Protocol: Plain HTTP

### /ui → Port 9997 (Claude Code UI)

Requests to `/ui` are routed to port **9997** with the `/ui` prefix stripped:
- `/ui` → routes to `localhost:9997/` (HTML page)
- `/ui/` → routes to `localhost:9997/` (HTML page)
- `/ui/icons/claude-ai-icon.svg` → routes to `localhost:9997/icons/claude-ai-icon.svg` (Icon asset)
- `/ui/assets/main.js` → routes to `localhost:9997/assets/main.js` (JavaScript asset)

Additionally, Claude Code UI frontend uses the following routes WITHOUT the `/ui` prefix:
- `/api/*` → routes to `localhost:9997/api/*` (API endpoints)
- `/ws/*` → routes to `localhost:9997/ws/*` (WebSocket endpoints)

Protocol: Plain HTTP

**Special HTML Rewriting**: For `/ui` route responses, absolute asset paths are rewritten:
- `/icons/...` → `/ui/icons/...`
- `/assets/...` → `/ui/assets/...`
- `/favicon...` → `/ui/favicon...`

This ensures assets load correctly through the proxy path.

### Default Routes → TARGET_PORT (6901)

All other paths route to the default `TARGET_PORT` (KasmVNC):
- `/` → routes to `localhost:6901/`
- Any other path not matching above routes

Protocol: HTTPS

## Authentication

If `VNC_PW` environment variable is set, HTTP Basic Authentication is required for ALL routes:
- All `/ssh` requests
- All `/files` requests
- All `/ui` requests
- All `/api` requests (Claude Code UI API)
- All `/ws` requests (Claude Code UI WebSocket)
- Uses username `kasm_user` with `VNC_PW` as the password

The auth header is only added automatically if the incoming request doesn't already have authorization.

## Technical Notes

- Both HTTP and WebSocket handlers implement the same routing and path transformation logic
- Host headers are dynamically updated based on the target port
- Path matching is precise: `path === '/path' || path.startsWith('/path/') || path.startsWith('/path?')`
- Cached credentials from successful HTTP requests are reused for WebSocket auth
- **Upstream protocol selection is dynamic per-port:**
  - Ports 9999, 9998, 9997: Plain HTTP
  - Port 6901 (kasmvnc) and others: HTTPS with TLS wrapping
- **HTML response body rewriting:**
  - For `/files` route: Relative asset paths rewritten to include `/files` prefix
  - For `/ui` route: Absolute asset paths (`/icons/`, `/assets/`, `/favicon`) rewritten to include `/ui` prefix
  - Only HTML content-type responses are rewritten; other content passes through unchanged
  - Content-Length header updated after rewriting; Transfer-Encoding removed to avoid conflicts
