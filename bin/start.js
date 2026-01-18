#!/usr/bin/env node
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const CUSTOM_PORT = parseInt(process.env.CUSTOM_PORT || '3000');  // Webtop UI port (LinuxServer webtop)
const TARGET_PORT = parseInt(process.env.TARGET_PORT || CUSTOM_PORT);  // Fallback to CUSTOM_PORT for backwards compatibility
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '80');
const VNC_PW = process.env.VNC_PW || '';
const SUBFOLDER = (process.env.SUBFOLDER || '/').replace(/\/+$/, '') || '/';  // Normalized path without trailing slash
const SELKIES_WS_PORT = 8082;  // Selkies WebSocket port (no auth needed)

// Store credentials from successful HTTP auth to use for WebSocket
let cachedAuth = null;

// Helper function to strip SUBFOLDER prefix from request path
function stripSubfolder(fullPath) {
  if (SUBFOLDER === '/') return fullPath;

  // Remove query string for comparison
  const pathOnly = fullPath.split('?')[0];

  if (pathOnly === SUBFOLDER.slice(0, -1) || pathOnly === SUBFOLDER) {
    return '/';
  }

  if (pathOnly.startsWith(SUBFOLDER)) {
    return pathOnly.slice(SUBFOLDER.length - 1) + (fullPath.includes('?') ? '?' + fullPath.split('?')[1] : '');
  }

  // Path doesn't match SUBFOLDER, return as-is
  return fullPath;
}

// Helper function to determine target port based on path (after SUBFOLDER stripping)
function getTargetPort(path) {
  // Strip SUBFOLDER prefix first
  const strippedPath = stripSubfolder(path);

  // Match /data/* routes to Selkies WebSocket (port 8082, no auth)
  if (strippedPath === '/data' || strippedPath.startsWith('/data/') || strippedPath.startsWith('/data?')) {
    return SELKIES_WS_PORT;
  }
  // Match /ws/* routes to Selkies WebSocket (port 8082, no auth)
  // Note: /ws/* here is Selkies, not Claude Code UI /ws (which is /ws/claude)
  if (strippedPath === '/ws' || strippedPath.startsWith('/ws/') || strippedPath.startsWith('/ws?')) {
    // Check if it's /ws/claude (Claude Code UI) vs /ws/* (Selkies)
    if (strippedPath === '/ws' || strippedPath.startsWith('/ws/')) {
      // Selkies uses /ws/* for WebSocket streaming
      return SELKIES_WS_PORT;
    }
  }
  // Match /ssh exactly, /ssh/, or /ssh?query
  if (strippedPath === '/ssh' || strippedPath.startsWith('/ssh/') || strippedPath.startsWith('/ssh?')) {
    return 9999;
  }
  // Match /files routes to port 9998 (file-manager)
  if (strippedPath === '/files' || strippedPath.startsWith('/files/') || strippedPath.startsWith('/files?')) {
    return 9998;
  }
  // Match /ui routes, /api routes, and /ws routes to Claude Code UI on port 9997
  // (Claude Code UI frontend requests /api/* and /ws without /ui prefix)
  if (strippedPath === '/ui' || strippedPath.startsWith('/ui/') || strippedPath.startsWith('/ui?') ||
      strippedPath === '/api' || strippedPath.startsWith('/api/') || strippedPath.startsWith('/api?') ||
      strippedPath === '/ws' || strippedPath.startsWith('/ws/') || strippedPath.startsWith('/ws?')) {
    return 9997;
  }
  return TARGET_PORT;  // Default to Webtop web UI (CUSTOM_PORT)
}

// Helper function to transform path based on routing (handles SUBFOLDER stripping and port-specific transformations)
function getTargetPath(path, targetPort) {
  // First strip SUBFOLDER prefix
  const strippedPath = stripSubfolder(path);

  // Selkies WebSocket routes - no path transformation needed
  if (targetPort === SELKIES_WS_PORT) {
    return strippedPath;  // Already stripped of SUBFOLDER
  }

  if (targetPort === 9999) {
    // Strip /ssh prefix for ttyd terminal
    if (strippedPath === '/ssh') {
      return '/';
    }
    if (strippedPath.startsWith('/ssh/')) {
      return strippedPath.substring(4); // /ssh/x -> /x
    }
    if (strippedPath.startsWith('/ssh?')) {
      return '/' + strippedPath.substring(4); // /ssh?x -> /?x
    }
  }
  if (targetPort === 9998) {
    // Strip /files prefix for file manager
    if (strippedPath === '/files') {
      return '/';
    }
    if (strippedPath.startsWith('/files/')) {
      return strippedPath.substring(6); // /files/x -> /x
    }
    if (strippedPath.startsWith('/files?')) {
      return '/' + strippedPath.substring(6); // /files?x -> /?x
    }
  }
  if (targetPort === 9997) {
    // Strip /ui prefix for Claude Code UI
    if (strippedPath === '/ui') {
      return '/';
    }
    if (strippedPath.startsWith('/ui/')) {
      return strippedPath.substring(3); // /ui/x -> /x
    }
    if (strippedPath.startsWith('/ui?')) {
      return '/' + strippedPath.substring(3); // /ui?x -> /?x
    }
    // Keep standalone /api and /ws paths as-is (Claude Code UI frontend uses these)
    if (strippedPath === '/api' || strippedPath.startsWith('/api/') || strippedPath.startsWith('/api?') ||
        strippedPath === '/ws' || strippedPath.startsWith('/ws/') || strippedPath.startsWith('/ws?')) {
      return strippedPath;
    }
  }
  // All other paths (Webtop web UI) pass through with SUBFOLDER stripped
  return strippedPath;
}

// Helper function to check if port uses plain HTTP (not HTTPS)
function isPlainHttpPort(port) {
  // Ports 9999 (ttyd), 9998 (file-manager), 9997 (Claude Code UI), and 8082 (Selkies) use plain HTTP
  return port === 9999 || port === 9998 || port === 9997 || port === SELKIES_WS_PORT;
}

// Helper function to get basic auth header
function getBasicAuth() {
  if (!VNC_PW) return null;
  // Use kasm_user username with VNC password
  const credentials = 'kasm_user:' + VNC_PW;
  const encoded = Buffer.from(credentials).toString('base64');
  return 'Basic ' + encoded;
}

// Helper function to rewrite relative paths in HTML for routing
function rewriteHtmlPaths(html, clientPath) {
  if (!clientPath || clientPath === '/') return html;

  // Only rewrite relative paths that don't start with / or http
  // This handles: src="js/file.js" -> src="/file/js/file.js"
  // And: href="css/style.css" -> href="/file/css/style.css"
  // But NOT: src="/js/file.js" or href="http://..."

  // Pattern: src/href followed by optional whitespace, =, optional whitespace, ", optional relative path, "
  // Relative paths: don't start with /, http://, or https://

  let rewritten = html
    .replace(/\b(src|href)=["'](?!\/|http|\/\/|data:)([^"']+)["']/g, (match, attr, path) => {
      // Rewrite relative path to be prefixed with the client path
      return `${attr}="${clientPath}/${path}"`;
    });

  // Also rewrite hardcoded WebSocket URLs in JavaScript config
  // Replace "url":"http://localhost:9999" with "url":""
  // Empty URL tells socket.io to use the current page's origin/protocol
  // This makes the WebSocket connect through the proxy instead of directly to localhost
  rewritten = rewritten.replace(/"url":"http:\/\/localhost:\d+"/g, '"url":""');

  // Special handling for /ui (Claude Code UI) - rewrite absolute paths
  if (clientPath === '/ui') {
    // Rewrite absolute paths like /assets/, /icons/, /favicon to /ui/assets/, etc.
    rewritten = rewritten
      .replace(/\b(src|href)=["'](\/assets\/[^"']+)["']/g, (match, attr, path) => {
        return `${attr}="/ui${path}"`;
      })
      .replace(/\b(src|href)=["'](\/icons\/[^"']+)["']/g, (match, attr, path) => {
        return `${attr}="/ui${path}"`;
      })
      .replace(/\b(src|href)=["'](\/favicon[^"']+)["']/g, (match, attr, path) => {
        return `${attr}="/ui${path}"`;
      });
  }

  // Special handling for /files (NHFS file manager) - rewrite absolute paths
  if (clientPath === '/files') {
    // Rewrite all absolute paths that don't already have /files prefix
    // href="/foo" -> href="/files/foo", href="/" -> href="/files/"
    rewritten = rewritten.replace(/\b(src|href)=["'](\/(?!files\/|files"|files')[^"']*)["']/g, (match, attr, path) => {
      return `${attr}="/files${path}"`;
    });
  }

  return rewritten;
}

// Helper function to check if path requires auth
function pathRequiresAuth(path, targetPort) {
  // Selkies WebSocket doesn't require auth (handles its own authentication via VNC password in URL)
  if (targetPort === SELKIES_WS_PORT) {
    return false;
  }
  // Auth required for ALL other routes when VNC_PW is set (including port 9997)
  return true;
}

// Helper function to check auth header
function checkAuth(authHeader) {
  if (!authHeader) return false;
  const [scheme, credentials] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;

  try {
    const decoded = Buffer.from(credentials, 'base64').toString();
    // Expected format: kasm_user:VNC_PW
    if (decoded !== 'kasm_user:' + VNC_PW) return false;
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const targetPort = getTargetPort(req.url);
  const targetPath = getTargetPath(req.url, targetPort);
  const clientPath = req.url.split('?')[0]; // Get path without query string

  // Check auth if VNC_PW is set and this port requires auth
  if (VNC_PW && pathRequiresAuth(req.url, targetPort)) {
    if (!checkAuth(req.headers.authorization)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="kasmproxy"',
        'Content-Type': 'text/plain'
      });
      res.end('Unauthorized');
      return;
    }
  }

  const headers = {
    ...req.headers,
    host: `${TARGET_HOST}:${targetPort}`
  };

  // Remove Accept-Encoding to prevent compressed responses
  // We need to read/modify HTML bodies, can't do that with gzip
  delete headers['accept-encoding'];

  // Add basic auth if VNC_PW is set and not already authenticated
  const basicAuth = getBasicAuth();
  if (basicAuth && !headers.authorization) {
    headers.authorization = basicAuth;
  }

  // Inject cached auth if HTTP request doesn't have auth
  if (!headers.authorization && cachedAuth) {
    headers.authorization = cachedAuth;
    console.log('Injected cached auth into HTTP request');
  }

  const options = {
    hostname: TARGET_HOST,
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers,
    rejectUnauthorized: false
  };

  // Choose protocol based on target port: HTTP for 9999/9998, HTTPS for others
  const protocolModule = isPlainHttpPort(targetPort) ? http : https;
  const proxyReq = protocolModule.request(options, (proxyRes) => {
    // Cache auth credentials if request succeeds (non-401)
    if (proxyRes.statusCode !== 401 && headers.authorization) {
      cachedAuth = headers.authorization;
      console.log('Cached auth credentials for WebSocket');
    }

    // Check if we need to rewrite the response body
    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    console.log(`[HTTP] ${req.method} ${req.url} -> ${targetPort}${targetPath} | CT: ${contentType} | HTML: ${isHtml}`);

    if (isHtml) {
      // Collect the full body, rewrite it, then send it
      let body = '';

      proxyRes.on('data', (chunk) => {
        body += chunk.toString();
      });

      proxyRes.on('end', () => {
        // Rewrite relative paths
        const rewrittenBody = rewriteHtmlPaths(body, clientPath);

        // Log if rewrite changed anything
        if (body !== rewrittenBody) {
          console.log(`[REWRITE] Body changed, old size: ${body.length}, new size: ${rewrittenBody.length}`);
        }

        // Update content-length since body may have changed
        // Remove transfer-encoding since we're setting content-length (they conflict)
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['transfer-encoding'];
        responseHeaders['content-length'] = Buffer.byteLength(rewrittenBody);

        res.writeHead(proxyRes.statusCode, responseHeaders);
        res.end(rewrittenBody);
      });
    } else {
      // For non-HTML, just pass through
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    console.error('Proxy error:', e.message);
    res.writeHead(502);
    res.end('Proxy error');
  });

  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  console.log('WebSocket upgrade:', req.url);

  const targetPort = getTargetPort(req.url);
  const targetPath = getTargetPath(req.url, targetPort);
  const isPlainHttp = isPlainHttpPort(targetPort);

  // Check auth if VNC_PW is set and this port requires auth
  if (VNC_PW && pathRequiresAuth(req.url, targetPort)) {
    if (!checkAuth(req.headers.authorization)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="kasmproxy"\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  console.log(`[WS] Routing to ${TARGET_HOST}:${targetPort}${targetPath}`);

  const targetSocket = net.connect(targetPort, TARGET_HOST, () => {
    console.log('[WS] Connected to upstream');

    // For HTTPS ports, wrap with TLS. For HTTP ports, use socket directly.
    const workingSocket = isPlainHttp ? targetSocket : tls.connect({
      socket: targetSocket,
      rejectUnauthorized: false,
      servername: TARGET_HOST
    });

    const handleConnection = () => {
      console.log('[WS] Upstream connection ready');

      const headers = { ...req.headers, host: `${TARGET_HOST}:${targetPort}` };

      // Add basic auth if VNC_PW is set and not already authenticated
      const basicAuth = getBasicAuth();
      if (basicAuth && !headers.authorization) {
        headers.authorization = basicAuth;
      }

      // Inject cached auth if WebSocket request doesn't have auth
      if (!headers.authorization && cachedAuth) {
        headers.authorization = cachedAuth;
        console.log('Injected cached auth into WebSocket');
      }

      // Build the upgrade request
      let upgradeRequest = `${req.method} ${targetPath} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        upgradeRequest += `${key}: ${value}\r\n`;
      }
      upgradeRequest += '\r\n';

      console.log('[WS] Sending upgrade request to upstream');
      workingSocket.write(upgradeRequest);
      if (head.length) {
        workingSocket.write(head);
        console.log('[WS] Sent head frame');
      }

      // Pipe data both directions
      workingSocket.pipe(socket);
      socket.pipe(workingSocket);
      console.log('[WS] Streams piped');

      workingSocket.on('error', (err) => {
        console.error('[WS] Upstream socket error:', err.message);
        socket.destroy();
      });

      socket.on('error', (err) => {
        console.error('[WS] Client socket error:', err.message);
        workingSocket.destroy();
      });
    };

    if (isPlainHttp) {
      // For plain HTTP, connection is ready immediately
      console.log('[WS] Plain HTTP - connection ready immediately');
      handleConnection();
    } else {
      // For TLS, wait for secure connection
      console.log('[WS] HTTPS - waiting for secureConnect');
      workingSocket.on('secureConnect', () => {
        console.log('[WS] TLS handshake complete');
        handleConnection();
      });

      workingSocket.on('error', (err) => {
        console.error('[WS] TLS error:', err.message);
        socket.destroy();
      });
    }
  });

  targetSocket.on('error', (err) => {
    console.error('[WS] Upstream connection error:', err.message);
    socket.destroy();
  });

  socket.on('error', (err) => {
    console.error('[WS] Client socket error during setup:', err.message);
    targetSocket.destroy();
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`kasmproxy: http://localhost:${LISTEN_PORT} -> https://${TARGET_HOST}:${TARGET_PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
