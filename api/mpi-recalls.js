// Vercel serverless proxy for MPI food recall data.
// Fetches the MPI RSS feed (or an individual notice page) server-side to
// avoid CORS restrictions in the browser.
//
// GET /api/mpi-recalls          → fetches the MPI recall RSS feed
// GET /api/mpi-recalls?url=...  → proxies the given URL (mpi.govt.nz only)

const MPI_FEED = 'https://www.mpi.govt.nz/food-safety-home/food-recalls-and-complaints/recalled-food-products';
const ALLOWED_HOST = 'www.mpi.govt.nz';

module.exports = async function handler(req, res) {
  // Determine target URL
  let targetUrl = MPI_FEED;
  if (req.query.url) {
    let parsed;
    try {
      parsed = new URL(req.query.url);
    } catch (e) {
      res.status(400).json({ error: 'Invalid URL parameter' });
      return;
    }
    if (parsed.hostname !== ALLOWED_HOST) {
      res.status(403).json({ error: 'URL not permitted — must be on ' + ALLOWED_HOST });
      return;
    }
    // Only allow https
    if (parsed.protocol !== 'https:') {
      res.status(403).json({ error: 'Only HTTPS URLs are permitted' });
      return;
    }
    targetUrl = parsed.href;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-NZ,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    const body = await upstream.text();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'Upstream fetch failed: ' + e.message });
  }
};
