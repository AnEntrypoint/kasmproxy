# Implementation Notes

## /shell Routing Constraint

### Gotcha: Path Matching Precision

When implementing the `/shell` routing constraint, be aware of partial matching:
- ❌ WRONG: `path.startsWith('/shell')` - matches `/shells` and `/shellfish` incorrectly
- ✅ CORRECT: `path === '/shell' || path.startsWith('/shell/') || path.startsWith('/shell?')`

The correct approach handles:
- Exact match: `/shell`
- Subpaths: `/shell/`, `/shell/nested`
- Query strings: `/shell?param=value`
- Does NOT match: `/shells`, `/shellfish`, `/shell2`

### Important: Both HTTP and WebSocket

The routing constraint must be applied in BOTH:
1. HTTP request handler (`http.createServer`)
2. WebSocket upgrade handler (`server.on('upgrade')`)

Forgetting either one will cause inconsistent behavior where one protocol routes correctly and the other doesn't.

### Host Header Critical

When routing to different ports, the `host` header MUST be updated:
```javascript
host: `${TARGET_HOST}:${targetPort}`
```

Not updating this header will cause requests to still reference the wrong port in the Host header, potentially causing upstream routing issues.
