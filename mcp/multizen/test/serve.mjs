#!/usr/bin/env node
// Serve the test page for the MultiZen adaptor verification.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8848);
const html = fs.readFileSync(path.join(here, 'test.html'));

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  })
  .listen(PORT, '127.0.0.1', () => console.log('test page on http://127.0.0.1:' + PORT + '/'));
