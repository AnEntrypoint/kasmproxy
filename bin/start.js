#!/usr/bin/env node
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '6901');
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '80');
const VNC_PW = process.env.VNC_PW || '';

// Store credentials from successful HTTP auth to use for WebSocket
let cachedAuth = null;

// Helper function to determine target port based on path
function getTargetPort(path) {
  // Match /ssh exactly, /ssh/, or /ssh?query
  if (path === '/ssh' || path.startsWith('/ssh/') || path.startsWith('/ssh?')) {
    return 9999;
  }
  // Match /files and /api routes to port 9998
  if (path === '/files' || path.startsWith('/files/') || path.startsWith('/files?') ||
      path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) {
    return 9998;
  }
  // Match /ui routes to Claude Code UI on port 9997
  if (path === '/ui' || path.startsWith('/ui/') || path.startsWith('/ui?')) {
    return 9997;
  }
  return TARGET_PORT;
}

// Helper function to transform path based on routing
function getTargetPath(path, targetPort) {
  if (targetPort === 9999) {
    // Strip /ssh prefix for ttyd terminal
    if (path === '/ssh') {
      return '/';
    }
    if (path.startsWith('/ssh/')) {
      return path.substring(4); // /ssh/x -> /x
    }
    if (path.startsWith('/ssh?')) {
      return '/' + path.substring(4); // /ssh?x -> /?x
    }
  }
  if (targetPort === 9998) {
    // Strip /files prefix for file manager
    if (path === '/files') {
      return '/';
    }
    if (path.startsWith('/files/')) {
      return path.substring(6); // /files/x -> /x
    }
    if (path.startsWith('/files?')) {
      return '/' + path.substring(6); // /files?x -> /?x
    }
    // Also handle /api routes
    if (path === '/api') {
      return '/api';
    }
    if (path.startsWith('/api/') || path.startsWith('/api?')) {
      return path; // Keep /api paths as-is
    }
  }
  if (targetPort === 9997) {
    // Strip /ui prefix for Claude Code UI
    if (path === '/ui') {
      return '/';
    }
    if (path.startsWith('/ui/')) {
      return path.substring(3); // /ui/x -> /x
    }
    if (path.startsWith('/ui?')) {
      return '/' + path.substring(3); // /ui?x -> /?x
    }
  }
  // All other paths pass through as-is
  return path;
}

// Helper function to check if port uses plain HTTP (not HTTPS)
function isPlainHttpPort(port) {
  // Ports 9999, 9998, and 9997 use plain HTTP
  return port === 9999 || port === 9998 || port === 9997;
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
  // This ONLY applies to /ui, not /files, /ssh, or root
  if (clientPath === '/ui') {
    // Rewrite absolute paths like /assets/, /api/, /ws/, /shell/ to /ui/assets/, etc.
    rewritten = rewritten
      .replace(/\b(src|href)=["'](\/assets\/[^"']+)["']/g, (match, attr, path) => {
        return `${attr}="/ui${path}"`;
      })
      .replace(/\b(src|href)=["'](\/favicon[^"']+)["']/g, (match, attr, path) => {
        return `${attr}="/ui${path}"`;
      });
  }

  return rewritten;
}

// Helper function to check if path requires auth
function pathRequiresAuth(path, targetPort) {
  // Auth required for ALL routes when VNC_PW is set
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
