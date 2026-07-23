import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Lets React's <ViewTransition> animate route changes — the prompt bar
    // morphs from centre stage on /workflow into the canvas dock, which is the
    // continuity the old single-route morph used to provide.
    viewTransition: true,
  },
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
