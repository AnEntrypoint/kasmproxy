# kasmproxy

SSL/WS proxy: HTTP(S) to HTTPS WebSocket bridge for Kasm workspaces.

## Configuration

Environment variables:
- `TARGET_HOST` (default: `localhost`) - Target host to proxy requests to
- `TARGET_PORT` (default: `6901`) - Default target port for proxied requests
- `LISTEN_PORT` (default: `8000`) - Port for kasmproxy to listen on
- `VNC_PW` (optional) - VNC password for HTTP basic auth (empty username, VNC_PW as password)

## Routing Constraints

### /ssh → Port 9999

Requests to `/ssh` (and all sub-paths like `/ssh/`, `/ssh/test`, and queries like `/ssh?param=value`) are automatically routed to port **9999** with basic HTTP auth if `VNC_PW` is set.

Examples:
- `/ssh` → routes to `localhost:9999/ssh`
- `/ssh/` → routes to `localhost:9999/ssh/`
- `/ssh/nested/path` → routes to `localhost:9999/ssh/nested/path`
- `/ssh?id=123` → routes to `localhost:9999/ssh?id=123`

### /file → Port 9998 (Path Transformed to /files)

Requests to `/file` (and all sub-paths/queries) are routed to port **9998** with the path transformed from `/file*` to `/files*`. Basic HTTP auth is added if `VNC_PW` is set.

Examples:
- `/file` → routes to `localhost:9998/files`
- `/file/` → routes to `localhost:9998/files/`
- `/file/document.pdf` → routes to `localhost:9998/files/document.pdf`
- `/file?id=123` → routes to `localhost:9998/files?id=123`

### Default Routes → TARGET_PORT (6901)

All other paths route to the default `TARGET_PORT`:
- `/api` → routes to `localhost:6901/api`
- `/` → routes to `localhost:6901/`
- `/files` (direct) → routes to `localhost:6901/files` (NOT transformed)

These routes do NOT get special paths matching (e.g., `/sshs` does not match `/ssh`).

## Authentication

If `VNC_PW` environment variable is set, HTTP Basic Authentication is automatically added to:
- All `/ssh` requests
- All `/file` requests
- Uses empty username with `VNC_PW` as the password (credentials: `:VNC_PW`)

The auth header is only added if the incoming request doesn't already have authorization.

## Technical Notes

- Both HTTP and WebSocket handlers implement the same routing and path transformation logic
- Host headers are dynamically updated based on the target port
- Path matching is precise: `path === '/path' || path.startsWith('/path/') || path.startsWith('/path?')`
- WebSocket upgrade requests receive transformed paths (e.g., `/file` → `/files`)
- Cached credentials from successful HTTP requests are reused for WebSocket auth
- **Upstream protocol selection is dynamic per-port:**
  - Port 9999 (/ssh): HTTP protocol
  - Port 9998 (/file): HTTP protocol
  - Port 6901 (kasmvnc) and others: HTTPS protocol

