#!/usr/bin/env node
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const TARGET_HOST = process.env.TARGET_HOST || 'localhost';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '6901');
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || '8000');

const server = http.createServer((req, res) => {
  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`
    },
    rejectUnauthorized: false
  };

  const proxyReq = https.request(options, (proxyRes) => {
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
  const targetSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const secureSocket = tls.connect({
      socket: targetSocket,
      rejectUnauthorized: false,
      servername: TARGET_HOST
    }, () => {
      const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
      let upgradeRequest = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        upgradeRequest += `${key}: ${value}\r\n`;
      }
      upgradeRequest += '\r\n';

      secureSocket.write(upgradeRequest);
      if (head.length) secureSocket.write(head);

      secureSocket.pipe(socket);
      socket.pipe(secureSocket);

      secureSocket.on('error', () => socket.destroy());
    });
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
