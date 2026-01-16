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

### /files → Port 9998 (File Manager)

Requests to `/files` and `/api` routes are routed to port **9998** for the file manager service:
- `/files` → routes to `localhost:9998/files` (HTML page)
- `/files/` → routes to `localhost:9998/files/` (HTML page)
- `/files?test=1` → routes to `localhost:9998/files?test=1` (HTML page with query)

### /files Assets → Port 9998 (Strip /files Prefix)

Asset requests under `/files` are transformed to root paths on upstream:
- `/files/js/app.js` → routes to `localhost:9998/js/app.js` (JavaScript asset)
- `/files/css/style.css` → routes to `localhost:9998/css/style.css` (CSS asset)
- `/files/images/logo.png` → routes to `localhost:9998/images/logo.png` (Image asset)
- `/files/webfonts/font.woff` → routes to `localhost:9998/webfonts/font.woff` (Font asset)

### /api → Port 9998 (File Manager API)

API requests route to port **9998** for file manager operations:
- `/api/` → routes to `localhost:9998/api/` (API endpoint list)
- `/api/options?type=GET_SHOW_ALL_FILES` → routes to `localhost:9998/api/options?type=GET_SHOW_ALL_FILES` (API call)

### Default Routes → TARGET_PORT (6901)

All other paths route to the default `TARGET_PORT`:
- `/` → routes to `localhost:6901/` (KasmVNC)
- Any other path not matching above routes

## Authentication

If `VNC_PW` environment variable is set, HTTP Basic Authentication is automatically added to:
- All `/ssh` requests
- All `/files` requests
- All `/api` requests
- Uses username `kasm_user` with `VNC_PW` as the password (credentials: `kasm_user:VNC_PW`)

The auth header is only added if the incoming request doesn't already have authorization.

## Technical Notes

- Both HTTP and WebSocket handlers implement the same routing and path transformation logic
- Host headers are dynamically updated based on the target port
- Path matching is precise: `path === '/path' || path.startsWith('/path/') || path.startsWith('/path?')`
- Cached credentials from successful HTTP requests are reused for WebSocket auth
- **Upstream protocol selection is dynamic per-port:**
  - Port 9999 (/ssh): HTTP protocol
  - Port 9998 (/files, /api): HTTP protocol
  - Port 6901 (kasmvnc) and others: HTTPS protocol
- **HTML response body rewriting** for `/files` route:
  - Relative asset paths (src/href) are rewritten to include the proxy path prefix
  - Asset directory requests (`/files/js/`, `/files/css/`, `/files/images/`, `/files/webfonts/`) strip the `/files` prefix to get root-relative upstream paths
  - Only HTML content-type responses are rewritten; other content passes through unchanged

