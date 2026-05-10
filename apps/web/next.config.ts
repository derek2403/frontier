import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@soda-sdk/core"],
  devIndicators: false,
};

export default nextConfig;
