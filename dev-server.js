// Local dev server: static files plus POST /api/generate.
// Run with: node --env-file=.env.local dev-server.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/generate.js';

const PORT = Number(process.env.PORT) || 3001;
const ROOT = fileURLToPath(new URL('.', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^[/\\]+/, '');
  const file = join(ROOT, rel);
  // Stay inside the project and keep dotfiles (.env.local) and server code private.
  const blocked = !file.startsWith(ROOT) || rel.split(sep).some((p) => p.startsWith('.')) || rel.startsWith('api' + sep);
  if (blocked) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/generate') {
    if (req.method === 'POST') {
      try {
        req.body = await readJson(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"failed"}');
        return;
      }
    }
    return handler(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`The Picture of Dorian Gray: http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.log('GEMINI_API_KEY is not set; add it to .env.local or use ?mock');
});
