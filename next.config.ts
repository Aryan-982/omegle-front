import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: {
    position: "top-right", // allowed property
  },
};

export default nextConfig;
