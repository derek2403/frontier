import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // soda-sdk is a workspace package shipping TypeScript source — Next must
  // transpile it like any of our own pages.
  transpilePackages: ["soda-sdk"],
};

export default nextConfig;
