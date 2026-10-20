import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `mqtt` pulls in Node built-ins; keep it out of the bundle tracing noise and
  // let the route handlers (Node runtime) require it directly.
  serverExternalPackages: ['mqtt'],
};

export default nextConfig;
