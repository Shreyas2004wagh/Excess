import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@excess/shared-types'],
};

export default nextConfig;
