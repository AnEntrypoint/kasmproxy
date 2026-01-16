# kasmproxy

SSL/WS proxy: HTTP(S) to HTTPS WebSocket bridge for Kasm workspaces.

## Configuration

Environment variables:
- `TARGET_HOST` (default: `localhost`) - Target host to proxy requests to
- `TARGET_PORT` (default: `6901`) - Default target port for proxied requests
- `LISTEN_PORT` (default: `8000`) - Port for kasmproxy to listen on

## Routing Constraint: /shell

Requests to `/shell` (and all sub-paths like `/shell/`, `/shell/test`, and queries like `/shell?param=value`) are automatically routed to port **9999** instead of the default `TARGET_PORT`.

This constraint applies to both HTTP requests and WebSocket upgrade connections.

### Examples:
- `/shell` → routes to `:9999`
- `/shell/` → routes to `:9999`
- `/shell/nested/path` → routes to `:9999`
- `/shell?id=123` → routes to `:9999`
- `/api` → routes to `TARGET_PORT`
- `/shells` → routes to `TARGET_PORT` (does NOT match /shell)

## Technical Notes

- Both HTTP and WebSocket handlers implement the same routing logic
- Host headers are dynamically updated based on the target port
- The routing check is: `path === '/shell' || path.startsWith('/shell/') || path.startsWith('/shell?')`
