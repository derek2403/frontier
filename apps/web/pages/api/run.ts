// SSE-streaming endpoint that drives the whole demo pipeline.
//
//   GET /api/run                          self-transfer
//   GET /api/run?recipient=0xAbC...       send to a specific address
//
// Emits these SSE events:
//   step    — { kind: "step", name, status: "active" | "done" | "error", data? }
//   log     — { kind: "log", message }
//   done    — RunResult
//   fail    — { message }

import type { NextApiRequest, NextApiResponse } from "next";
import { runDemo, type RunEvent } from "@/lib/run-demo";

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const recipient = (req.query.recipient as string | undefined)?.trim() || undefined;

  try {
    const result = await runDemo(recipient, (event: RunEvent) => {
      send(event.kind, event);
    });
    send("done", result);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    send("fail", { message });
  }
  res.end();
}
