#!/usr/bin/env node
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '6901');
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8000');
const VNC_PW = process.env.VNC_PW || '';

// Store credentials from successful HTTP auth to use for WebSocket
let cachedAuth = null;

// Helper function to determine target port based on path
function getTargetPort(path) {
  // Match /ssh exactly, /ssh/, or /ssh?query
  if (path === '/ssh' || path.startsWith('/ssh/') || path.startsWith('/ssh?')) {
    return 9999;
  }
  // Match /file exactly, /file/, or /file?query
  if (path === '/file' || path.startsWith('/file/') || path.startsWith('/file?')) {
    return 9998;
  }
  return TARGET_PORT;
}

// Helper function to transform path based on routing
function getTargetPath(path, targetPort) {
  if (targetPort === 9998) {
    // Transform /file -> /files, /file/test -> /files/test, /file?x -> /files?x
    // But NOT /file/js, /file/css, /file/images, /file/webfonts, /file/api (these are rewritten assets/apis that resolve to root paths)
    if (path === '/file') return '/files';
    if (path.startsWith('/file/')) {
      // Check if this is an asset path or API call (has known directories or /api prefix)
      if (path.startsWith('/file/js/') || path.startsWith('/file/css/') || path.startsWith('/file/images/') ||
          path.startsWith('/file/webfonts/') || path.startsWith('/file/api/')) {
        // This is a rewritten asset or API call - strip /file prefix to get actual path
        return path.substring(5); // /file/js/x -> /js/x, /file/api/x -> /api/x
      }
      return '/files' + path.substring(5);
    }
    if (path.startsWith('/file?')) return '/files' + path.substring(5);
  }
  // For /ssh and default port, keep path as-is
  return path;
}

// Helper function to check if port uses plain HTTP (not HTTPS)
function isPlainHttpPort(port) {
  // Only ports 9999 and 9998 use plain HTTP
  return port === 9999 || port === 9998;
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

  return rewritten;
}

// Helper function to check if path requires auth
function pathRequiresAuth(path) {
  // Auth required for /ssh and /file routes
  return path === '/ssh' || path.startsWith('/ssh/') || path.startsWith('/ssh?') ||
         path === '/file' || path.startsWith('/file/') || path.startsWith('/file?');
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
  // Check auth if VNC_PW is set and this path requires auth
  if (VNC_PW && pathRequiresAuth(req.url)) {
    if (!checkAuth(req.headers.authorization)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="kasmproxy"',
        'Content-Type': 'text/plain'
      });
      res.end('Unauthorized');
      return;
    }
  }

  const targetPort = getTargetPort(req.url);
  const targetPath = getTargetPath(req.url, targetPort);
  const clientPath = req.url.split('?')[0]; // Get path without query string

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
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'content-length': Buffer.byteLength(rewrittenBody)
        });
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

  // Check auth if VNC_PW is set and this path requires auth
  if (VNC_PW && pathRequiresAuth(req.url)) {
    if (!checkAuth(req.headers.authorization)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="kasmproxy"\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const targetPort = getTargetPort(req.url);
  const targetPath = getTargetPath(req.url, targetPort);
  const isPlainHttp = isPlainHttpPort(targetPort);

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
