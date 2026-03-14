const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
    let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
}

// Proxy endpoint: /download-image?url=<encoded-url>
// Fetches images server-side (no CORS restrictions)
function proxyImage(imageUrl, res) {
    const parsedUrl = new URL(imageUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    client.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
        // Follow redirects
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            proxyImage(proxyRes.headers.location, res);
            return;
        }

        if (proxyRes.statusCode !== 200) {
            res.writeHead(proxyRes.statusCode);
            res.end('Upstream error');
            return;
        }

        res.writeHead(200, {
            'Content-Type': proxyRes.headers['content-type'] || 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        proxyRes.pipe(res);
    }).on('error', (err) => {
        console.error('Proxy error:', err.message);
        res.writeHead(500);
        res.end('Proxy error: ' + err.message);
    });
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (parsed.pathname === '/download-image' && parsed.query.url) {
        proxyImage(parsed.query.url, res);
    } else {
        serveStatic(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`\n  🚀 Server running at http://localhost:${PORT}\n`);
    console.log(`  Open http://localhost:${PORT} in your browser\n`);
    console.log(`  Image proxy available at /download-image?url=<image-url>\n`);
});
