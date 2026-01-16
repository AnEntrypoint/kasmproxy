# kasmproxy

SSL/WS proxy: HTTP(S) to HTTPS WebSocket bridge for Kasm workspaces.

## Configuration

Environment variables:
- `TARGET_HOST` (default: `localhost`) - Target host to proxy requests to
- `TARGET_PORT` (default: `6901`) - Default target port for proxied requests
- `LISTEN_PORT` (default: `8000`) - Port for kasmproxy to listen on

## Routing Constraint: /ssh

Requests to `/ssh` (and all sub-paths like `/ssh/`, `/ssh/test`, and queries like `/ssh?param=value`) are automatically routed to port **9999** instead of the default `TARGET_PORT`.

This constraint applies to both HTTP requests and WebSocket upgrade connections.

### Examples:
- `/ssh` → routes to `:9999`
- `/ssh/` → routes to `:9999`
- `/ssh/nested/path` → routes to `:9999`
- `/ssh?id=123` → routes to `:9999`
- `/api` → routes to `TARGET_PORT`
- `/sshs` → routes to `TARGET_PORT` (does NOT match /ssh)

## Technical Notes

- Both HTTP and WebSocket handlers implement the same routing logic
- Host headers are dynamically updated based on the target port
- The routing check is: `path === '/ssh' || path.startsWith('/ssh/') || path.startsWith('/ssh?')`
