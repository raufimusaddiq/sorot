/** @type {import('next').NextConfig} */
// Static export: `next build` writes plain HTML/JS to ./out, which the Bun
// backend serves at http://localhost:8080 (same origin as /api, no CORS).
// For hot-reload work run `next dev` on :3000 with NEXT_PUBLIC_API_URL set
// to the backend (see .env.local); the backend allows that origin via CORS.
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

module.exports = nextConfig;
