/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.ARGUS_STANDALONE_BUILD === "true" ? { output: "standalone" } : {}),
  poweredByHeader: false,
  experimental: { externalDir: true },
};

export default nextConfig;
