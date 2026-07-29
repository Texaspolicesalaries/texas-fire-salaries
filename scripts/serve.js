#!/usr/bin/env node
/*
 * serve.js — Minimal static file server for local preview (no deps).
 * Mirrors Cloudflare Pages behavior closely enough for development:
 * directory URLs resolve to index.html; unknown paths fall back to 404.
 * Run: npm run serve   (defaults to port 8788, override with PORT=xxxx)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 8788;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  let filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (e, data) => {
      if (e) {
        const nf = path.join(ROOT, '404.html');
        return fs.readFile(nf, (e2, d2) => {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(e2 ? 'Not found: ' + urlPath : d2);
        });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

server.listen(PORT, () => console.log(`Texas Fire Salaries dev server: http://localhost:${PORT}`));
