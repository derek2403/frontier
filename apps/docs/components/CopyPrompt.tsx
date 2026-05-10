import { useState } from 'react'
import { ClaudeIcon, ChatGPTIcon } from './icons'

type Props = {
  prompt: string
  label?: string
}

const SKILL_URL =
  'https://raw.githubusercontent.com/derek2403/frontier/main/.claude/skills/soda/SKILL.md'

/**
 * Copies a ready-to-paste AI prompt to the clipboard. The default prompt
 * tells the agent to fetch the SODA skill, then performs the page-specific
 * task, so a user can paste straight into Claude / ChatGPT / Cursor.
 */
export default function CopyPrompt({ prompt, label = 'Copy as AI prompt' }: Props) {
  const [copied, setCopied] = useState(false)

  const fullPrompt = `Read this SODA skill first: ${SKILL_URL}

Then help me with the following:

${prompt}`

  function onClick() {
    navigator.clipboard
      .writeText(fullPrompt)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
      })
      .catch(() => {
        // ignore — fallback would be selecting a hidden textarea, not worth it for one button
      })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="soda-copy-prompt"
      aria-live="polite"
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
        <ClaudeIcon size={14} />
        <ChatGPTIcon size={14} />
      </span>
      <span>{copied ? 'Copied — paste into your AI' : label}</span>
    </button>
  )
}
