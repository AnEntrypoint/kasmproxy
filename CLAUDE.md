# Implementation Notes

## Upstream Protocol: Dynamic Per-Port Selection

**CRITICAL**: Upstream protocols are selected dynamically based on target port:

- **Ports 9999 (/ssh) and 9998 (/files, /api)**: Plain HTTP via `http.request()` and raw `net.connect()`
- **Port 6901 (kasmvnc) and other ports**: HTTPS via `https.request()` with TLS wrapping

The proxy receives HTTPS connections from browsers but uses different protocols for upstream depending on the service:
- HTTP handler: Chooses `http.request()` or `https.request()` based on `isPlainHttpPort(targetPort)`
- WebSocket handler: Chooses plain socket or TLS-wrapped socket based on `isPlainHttpPort(targetPort)`

Attempting to use the wrong protocol (HTTPS for HTTP services, or HTTP for HTTPS services) will cause SSL handshake errors and 502 Bad Gateway responses.

## Path Routing & Transformation

### Gotcha: Path Matching Precision

When implementing path routing constraints, be aware of partial matching:
- ❌ WRONG: `path.startsWith('/ssh')` - matches `/sshs` and `/sshfish` incorrectly
- ✅ CORRECT: `path === '/ssh' || path.startsWith('/ssh/') || path.startsWith('/ssh?')`

The correct approach handles:
- Exact match: `/ssh`
- Subpaths: `/ssh/`, `/ssh/nested`
- Query strings: `/ssh?param=value`
- Does NOT match: `/sshs`, `/sshfish`, `/ssh2`

### Path Transformation for Assets

Asset requests under `/files` are transformed to root paths on upstream:
- `/files/js/app.js` → routes to port 9998 as `/js/app.js` (strip `/files` prefix)
- `/files/css/style.css` → routes to port 9998 as `/css/style.css` (strip `/files` prefix)
- `/files/images/logo.png` → routes to port 9998 as `/images/logo.png` (strip `/files` prefix)
- `/files/webfonts/font.woff` → routes to port 9998 as `/webfonts/font.woff` (strip `/files` prefix)

**CRITICAL**: The upstream file manager (port 9998) has assets at root paths (`/js/`, `/css/`), NOT under `/files/`. Asset directory requests must strip the `/files` prefix to get the correct upstream path.

**CRITICAL**: Path transformation must be applied in BOTH handlers:
1. HTTP request handler: `path: targetPath` in http.request options
2. WebSocket upgrade handler: `${req.method} ${targetPath}` in the upgrade request line

Forgetting either one causes incorrect upstream requests.

### Important: Both HTTP and WebSocket

All routing and path transformation must be applied in BOTH:
1. HTTP request handler (`http.createServer`)
2. WebSocket upgrade handler (`server.on('upgrade')`)

Forgetting either one will cause inconsistent behavior where one protocol routes correctly and the other doesn't.

### Host Header Critical

When routing to different ports, the `host` header MUST be updated:
```javascript
host: `${TARGET_HOST}:${targetPort}`
```

Not updating this header will cause requests to still reference the wrong port in the Host header, potentially causing upstream routing issues.

## HTTP Basic Authentication

### VNC_PW Environment Variable

Basic auth is automatically added to `/ssh`, `/files`, and `/api` routes when `VNC_PW` is set:
- Credentials format: `kasm_user` username + VNC_PW as password
- Base64 encoded: `Basic a2FzbV91c2VyOmZvb2Jhcg==` (for username "kasm_user" and password "foobar")
- Header: `Authorization: Basic BASE64_ENCODED_CREDENTIALS`

### Auth Enforcement on Proxy

When `VNC_PW` is set, the proxy enforces HTTP Basic Authentication on:
1. HTTP requests to `/ssh`, `/files`, and `/api` routes (returns 401 if auth invalid)
2. WebSocket upgrade requests to `/ssh`, `/files`, and `/api` routes (closes connection if auth invalid)

### Auth Header Precedence

The implementation adds basic auth only if:
1. `VNC_PW` environment variable is set AND
2. Incoming request doesn't already have an authorization header

This allows manual auth headers to override the automatic VNC_PW auth.

### Auth in WebSocket

WebSocket auth is cached from successful HTTP responses:
- When HTTP request succeeds (non-401), auth credentials are cached
- WebSocket upgrade requests without auth use the cached credentials
- Manual VNC_PW auth is also added to WebSocket if VNC_PW is set

**Gotcha**: Order matters. Check VNC_PW first, then use cached auth as fallback, to ensure consistent auth behavior.

## HTML Response Body Rewriting

### Relative Asset Paths Must Be Rewritten

When proxying responses that contain HTML with relative asset paths, they must be rewritten to be relative to the proxy path:

**Problem**: Upstream returns `src="js/app.js"`, which resolves to `/js/app.js` in the browser (root-relative)
**Solution**: Rewrite to `src="/files/js/app.js"` so assets are requested through the proxy

**Caveat**: The upstream file manager (port 9998) has assets at `/js/` and `/css/`, NOT `/files/js/` and `/files/css/`:
- HTML page: `/files` → `/files` (no transform, returns HTML with relative paths)
- Asset requests: `/files/js/app.js` → `/js/app.js` (strip `/files` prefix)

This requires special handling:
1. HTML responses: rewrite relative paths to include `/files` path prefix
2. Asset requests matching known asset directories: strip the `/files` prefix and route to upstream root-relative path

**CRITICAL**: Forgetting the asset directory detection will cause assets to be double-prefixed:
- ❌ WRONG: `/files/js/app.js` → `/files/js/app.js` (upstream returns 404)
- ✅ CORRECT: `/files/js/app.js` → `/js/app.js` (upstream returns 200)
