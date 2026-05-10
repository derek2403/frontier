import * as React from 'react'

type IconProps = {
  size?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * Claude / Anthropic mark — the 8-pointed asterisk.
 * Uses `fill="currentColor"` so the colour follows the parent (white on
 * the banner, dark in light-mode body, etc).
 */
export function ClaudeIcon({ size = 18, className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-label="Claude"
      role="img"
      className={className}
      style={style}
    >
      <path d="M12 2v8.586l6.071-6.071 1.414 1.414L13.414 12 22 12v2h-8.586l6.071 6.071-1.414 1.414L12 13.414V22h-2v-8.586l-6.071 6.071-1.414-1.414L8.586 12H0v-2h8.586L2.515 3.929l1.414-1.414L10 8.586V2z" />
    </svg>
  )
}

/**
 * OpenAI / ChatGPT mark — the knotted hexagonal flower (simplified).
 * Same currentColor treatment as ClaudeIcon.
 */
export function ChatGPTIcon({ size = 18, className, style }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-label="ChatGPT"
      role="img"
      className={className}
      style={style}
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9 5.985 5.985 0 0 0 4.51 2.01 6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.169a.072.072 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.495zM3.6 18.304a4.47 4.47 0 0 1-.534-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062l-4.83 2.788a4.5 4.5 0 0 1-6.151-1.643zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0L3.99 13.81a4.504 4.504 0 0 1-1.65-5.916zm16.597 3.857-5.833-3.367 2.015-1.165a.076.076 0 0 1 .071 0l4.83 2.79a4.494 4.494 0 0 1-.677 8.105v-5.678a.79.79 0 0 0-.406-.685zm2.01-3.024-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0l-5.843 3.371V6.898a.066.066 0 0 1 .028-.062l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.864l-2.02-1.165a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.758a.795.795 0 0 0-.393.682zm1.097-2.366 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}
