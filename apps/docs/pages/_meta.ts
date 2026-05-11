export default {
  index: {
    title: 'Introduction',
    theme: { breadcrumb: false },
  },
  quickstart: 'Quickstart',
  agents: 'Use with AI',
  architecture: 'Architecture',
  concepts: 'Concepts',
  guides: 'Guides',
  deploy: 'Deploy',
  reference: 'Reference',
  '-- demo': {
    type: 'separator',
    title: 'Demo',
  },
  demo_link: {
    title: 'Try the live demo ↗',
    type: 'page',
    href: process.env.NEXT_PUBLIC_DEMO_URL ?? 'https://frontier-web-five.vercel.app',
    newWindow: true,
  },
  '-- links': {
    type: 'separator',
    title: 'Links',
  },
  github_link: {
    title: 'GitHub ↗',
    type: 'page',
    href: 'https://github.com/derek2403/frontier',
    newWindow: true,
  },
}
