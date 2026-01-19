#!/usr/bin/env node
const http = require('http');

const WEBTOP_UI_PORT = 3000;
const SELKIES_WS_PORT = 8082;
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8080');
const PASSWORD = process.env.PASSWORD || '';
const SUBFOLDER = (process.env.SUBFOLDER || '/').replace(/\/+$/, '') || '/';

console.log(`[kasmproxy] PASSWORD: ${PASSWORD ? PASSWORD.substring(0, 3) + '***' : '(not set)'}`);
console.log(`[kasmproxy] Listening on port ${LISTEN_PORT}`);
console.log(`[kasmproxy] SUBFOLDER: ${SUBFOLDER}`);

function stripSubfolder(fullPath) {
  if (SUBFOLDER === '/') return fullPath;
  const pathOnly = fullPath.split('?')[0];
  if (pathOnly === SUBFOLDER.slice(0, -1) || pathOnly === SUBFOLDER) {
    return '/';
  }
  if (pathOnly.startsWith(SUBFOLDER)) {
    return pathOnly.slice(SUBFOLDER.length - 1) + (fullPath.includes('?') ? '?' + fullPath.split('?')[1] : '');
  }
  return fullPath;
}

function getUpstreamPort(path) {
  if (path.startsWith('/data') || path.startsWith('/ws')) {
    return SELKIES_WS_PORT;
  }
  return WEBTOP_UI_PORT;
}

function shouldBypassAuth(path) {
  if (path === '/data' || path.startsWith('/data/') || path.startsWith('/data?')) {
    return true;
  }
  if (path === '/ws' || path.startsWith('/ws/') || path.startsWith('/ws?')) {
    return true;
  }
  return false;
}

function checkAuth(authHeader) {
  if (!authHeader) return false;
  const [scheme, credentials] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;
  try {
    const decoded = Buffer.from(credentials, 'base64').toString();
    const expected = 'kasm_user:' + PASSWORD;
    if (decoded !== expected) return false;
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const path = stripSubfolder(req.url);
  const bypassAuth = shouldBypassAuth(path);

  if (PASSWORD && !bypassAuth) {
    if (!checkAuth(req.headers.authorization)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="kasmproxy"',
        'Content-Type': 'text/plain'
      });
      res.end('Unauthorized');
      return;
    }
  }

  const upstreamPort = getUpstreamPort(path);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  headers.host = `localhost:${upstreamPort}`;

  const options = {
    hostname: 'localhost',
    port: upstreamPort,
    path: path,
    method: req.method,
    headers
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[kasmproxy] Error forwarding request:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  const path = stripSubfolder(req.url);
  const bypassAuth = shouldBypassAuth(path);

  if (PASSWORD && !bypassAuth) {
    if (!checkAuth(req.headers.authorization)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="kasmproxy"\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized');
      socket.destroy();
      return;
    }
  }

  const upstreamPort = getUpstreamPort(path);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  headers.host = `localhost:${upstreamPort}`;

  const options = {
    hostname: 'localhost',
    port: upstreamPort,
    path: path,
    method: req.method,
    headers
  };

  const proxyReq = http.request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (key.toLowerCase() !== 'connection') {
        socket.write(`${key}: ${value}\r\n`);
      }
    }
    socket.write('Connection: Upgrade\r\n\r\n');

    if (proxyHead && proxyHead.length > 0) {
      socket.write(proxyHead);
    }

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    socket.on('error', () => proxySocket.destroy());
    proxySocket.on('error', () => socket.destroy());
    socket.on('close', () => proxySocket.destroy());
    proxySocket.on('close', () => socket.destroy());
  });

  proxyReq.on('response', (proxyRes) => {
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      socket.write(`${key}: ${value}\r\n`);
    }
    socket.write('\r\n');
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', (err) => {
    console.error('[kasmproxy] Error upgrading WebSocket:', err.message);
    socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway');
    socket.destroy();
  });

  proxyReq.end(head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[kasmproxy] Listening on port ${LISTEN_PORT}`);
  console.log(`[kasmproxy] Forwarding to Webtop UI on port ${WEBTOP_UI_PORT}`);
  console.log(`[kasmproxy] Forwarding /data and /ws to Selkies on port ${SELKIES_WS_PORT}`);
  console.log(`[kasmproxy] Public routes: /data/*, /ws/*`);
});

server.on('error', (err) => {
  console.error('[kasmproxy] Server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[kasmproxy] Shutting down...');
  server.close(() => process.exit(0));
});
