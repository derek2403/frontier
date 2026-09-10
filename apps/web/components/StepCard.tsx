// One numbered step of the demo. Shared by the EVM page and the Sui page so
// the two read as the same three-act flow with a different chain at the end.

import type { ReactNode } from "react";

// A step is `locked` until the one before it produced its artifact. Locking is
// visual + pointer-events only; the underlying buttons are separately disabled,
// so a stray click can never skip ahead.
export type StepState = "locked" | "active" | "done";

export default function StepCard({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  children: ReactNode;
}) {
  const locked = state === "locked";
  return (
    <section
      aria-current={state === "active" ? "step" : undefined}
      className={[
        "rounded-2xl border p-5 transition",
        state === "active"
          ? "border-emerald-700/70 bg-zinc-900/60"
          : state === "done"
            ? "border-zinc-800 bg-zinc-900/30"
            : "border-zinc-900 bg-zinc-900/10",
        locked ? "pointer-events-none select-none opacity-40" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-3">
        <span
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            state === "done"
              ? "bg-emerald-500 text-emerald-950"
              : state === "active"
                ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/60"
                : "bg-zinc-800 text-zinc-500",
          ].join(" ")}
        >
          {state === "done" ? "✓" : n}
        </span>
        <h2
          className={[
            "text-sm font-medium",
            state === "locked" ? "text-zinc-500" : "text-zinc-100",
          ].join(" ")}
        >
          {title}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
