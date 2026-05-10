import React from 'react'
import { DocsThemeConfig, useConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: (
    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, letterSpacing: '0.04em' }}>
      <img src="/logo.png" alt="SODA" width={28} height={28} style={{ borderRadius: 6 }} />
      SODA <span style={{ opacity: 0.6, fontWeight: 400 }}>docs</span>
    </span>
  ),
  banner: {
    key: 'soda-skill-2026-05',
    dismissible: true,
    content: (
      <a href="/agents" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        🤖 <strong>New:</strong> Install the SODA skill into Claude Code, Codex, or Cursor in one command →
      </a>
    ),
  },
  project: {
    link: 'https://github.com/JingYuan0926/frontier',
  },
  docsRepositoryBase: 'https://github.com/JingYuan0926/frontier/tree/main/apps/docs',
  footer: {
    content: (
      <span>
        SODA: Solana-Owned Derived Authority. Built at the Frontier Hackathon, 2026.
      </span>
    ),
  },
  head: function Head() {
    const { frontMatter } = useConfig() as { frontMatter: { title?: string; description?: string } }
    const pageTitle = frontMatter.title ? `${frontMatter.title} – SODA` : 'SODA Docs'
    const description =
      frontMatter.description ||
      'Chain Signatures for Solana. A primitive for programs to control native external-chain assets.'
    return (
      <>
        <title>{pageTitle}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={description} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={description} />
      </>
    )
  },
  sidebar: {
    defaultMenuCollapseLevel: 2,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  darkMode: true,
  primaryHue: 270,
  primarySaturation: 80,
  feedback: {
    content: null,
  },
  editLink: {
    content: 'Edit this page on GitHub',
  },
}

export default config
