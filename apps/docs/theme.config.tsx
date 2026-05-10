import React from 'react'
import { DocsThemeConfig, useConfig } from 'nextra-theme-docs'
import { ClaudeIcon, ChatGPTIcon } from './components/icons'

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
        <ClaudeIcon size={16} />
        <ChatGPTIcon size={16} />
        <strong>New:</strong> Install the SODA skill into Claude Code, Codex, or Cursor in one command →
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
    const pageTitle = frontMatter.title ? `SODA Docs · ${frontMatter.title}` : 'SODA Docs'
    const description =
      frontMatter.description ||
      'Chain Signatures for Solana. A primitive for programs to control native external-chain assets.'
    return (
      <>
        <title>{pageTitle}</title>
        <link rel="icon" type="image/png" href="/logo.png" />
        <link rel="apple-touch-icon" href="/logo.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={description} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:image" content="/logo.png" />
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
  feedback: {
    content: null,
  },
  editLink: {
    content: 'Edit this page on GitHub',
  },
}

export default config
