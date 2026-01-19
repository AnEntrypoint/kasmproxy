# Kasmproxy - HTTP Basic Auth Reverse Proxy

Simple HTTP reverse proxy for LinuxServer Webtop that:
- Listens on port 8080 (non-privileged, suitable for abc user)
- Enforces HTTP Basic Auth (kasm_user:PASSWORD)
- Routes /data/* and /ws/* to Selkies:8082 (bypasses auth)
- Routes all other paths to Webtop:3000 (requires auth)
- Strips SUBFOLDER prefix from paths

## Environment Variables

- `LISTEN_PORT`: Port to listen on (default: 8080)
- `PASSWORD`: HTTP Basic Auth password (blank = no auth)
- `SUBFOLDER`: Path prefix to strip from incoming requests (default: /)

## Routing Rules

- /data/* → Selkies:8082 (public, no auth required)
- /ws/* → Selkies:8082 (public, no auth required)
- /* → Webtop:3000 (requires auth if PASSWORD set)
