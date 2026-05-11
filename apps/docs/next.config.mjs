import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
  defaultShowCopyCode: true,
})

const DEMO_URL =
  process.env.NEXT_PUBLIC_DEMO_URL ?? 'https://frontier-web-five.vercel.app'

export default withNextra({
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  devIndicators: false,
  async redirects() {
    // Convenience redirects so anyone visiting the docs domain at /demo or
    // /app lands on the live frontend. The docs site stays at the root URL.
    return [
      { source: '/demo', destination: DEMO_URL, permanent: false },
      { source: '/app',  destination: DEMO_URL, permanent: false },
    ]
  },
})
