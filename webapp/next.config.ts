import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',

  // Keep production type-checking focused on shipped application code. Vitest
  // owns the test suite, including its test-only mocks and fixtures.
  typescript: {
    tsconfigPath: './tsconfig.build.json',
  },

  serverExternalPackages: ['neo4j-driver', 'pdfjs-dist', 'pdf-parse'],

  images: {
    remotePatterns: [],
  },

  env: {
    NEO4J_URI: process.env.NEO4J_URI,
    NEO4J_USER: process.env.NEO4J_USER,
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD,
    NEXT_PUBLIC_REDAMON_VERSION: process.env.NEXT_PUBLIC_REDAMON_VERSION,
  },
}

export default nextConfig
