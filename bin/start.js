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
    if (path === '/file') return '/files';
    if (path.startsWith('/file/')) return '/files' + path.substring(5);
    if (path.startsWith('/file?')) return '/files' + path.substring(5);
  }
  // For /ssh and default port, keep path as-is
  return path;
}

// Helper function to get basic auth header
function getBasicAuth() {
  if (!VNC_PW) return null;
  // Use empty username with VNC password
  const credentials = ':' + VNC_PW;
  const encoded = Buffer.from(credentials).toString('base64');
  return 'Basic ' + encoded;
}

const server = http.createServer((req, res) => {
  const targetPort = getTargetPort(req.url);
  const targetPath = getTargetPath(req.url, targetPort);

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

  const proxyReq = http.request(options, (proxyRes) => {
    // Cache auth credentials if request succeeds (non-401)
    if (proxyRes.statusCode !== 401 && headers.authorization) {
      cachedAuth = headers.authorization;
      console.log('Cached auth credentials for WebSocket');
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
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

  const targetSocket = net.connect(targetPort, TARGET_HOST, () => {
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

    let upgradeRequest = `${req.method} ${targetPath} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      upgradeRequest += `${key}: ${value}\r\n`;
    }
    upgradeRequest += '\r\n';

    targetSocket.write(upgradeRequest);
    if (head.length) targetSocket.write(head);

    targetSocket.pipe(socket);
    socket.pipe(targetSocket);

    targetSocket.on('error', () => socket.destroy());
  });

  targetSocket.on('error', () => socket.destroy());
  socket.on('error', () => targetSocket.destroy());
});

server.listen(LISTEN_PORT, () => {
  console.log(`kasmproxy: http://localhost:${LISTEN_PORT} -> https://${TARGET_HOST}:${TARGET_PORT}`);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
