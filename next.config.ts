import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The studio moved to /workflow, where a canvas is addressable by id.
      // Temporary rather than permanent: a 308 is cached by the browser for
      // good, which is a long time to live with a route name.
      { source: "/studio", destination: "/workflow", permanent: false },
    ];
  },
};

export default nextConfig;
