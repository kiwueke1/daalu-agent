"use client";

import { useEffect, useRef } from "react";
import { Terminal, Loader2 } from "lucide-react";
import { useRemediationStream, type RemediationStep } from "@/lib/sse";

// Short phase tag + colour, terminal-style.
const PHASE: Record<string, { label: string; cls: string }> = {
  investigate: { label: "RUN", cls: "text-accent-cyan" },
  tool_result: { label: "OUT", cls: "text-muted" },
  propose: { label: "PROPOSE", cls: "text-signal-warning" },
  execute: { label: "EXEC", cls: "text-accent-cyan" },
  assistant: { label: "AGENT", cls: "text-fg" },
  done: { label: "DONE", cls: "text-accent" },
};

/**
 * Live, terminal-style log of what the remediation agent is doing right now —
 * read tools as they run, proposed writes awaiting approval, approved
 * executions and their raw output. Streams over SSE; only appears once there
 * is live activity (trigger a re-triage or approve an action to see it).
 */
export function ExecutionLog({ alertId }: { alertId: string }) {
  const steps = useRemediationStream(alertId);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [steps.length]);

  if (steps.length === 0) return null;

  const last = steps[steps.length - 1];
  const running = last.phase !== "done";

  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[11px] uppercase tracking-wider text-muted">
        <Terminal className="h-3.5 w-3.5" />
        Execution log
        {running ? (
          <span className="inline-flex items-center gap-1 text-accent-cyan">
            <Loader2 className="h-3 w-3 animate-spin" /> running
          </span>
        ) : (
          <span className="text-accent">complete</span>
        )}
        <span className="ml-auto tabular-nums">{steps.length} steps</span>
      </div>
      <div className="max-h-[360px] space-y-1.5 overflow-auto bg-bg-elevated/40 p-3 font-mono text-[12px] leading-relaxed">
        {steps.map((s, i) => (
          <LogLine key={i} step={s} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function LogLine({ step }: { step: RemediationStep }) {
  const meta =
    PHASE[step.phase] ?? { label: step.phase.toUpperCase(), cls: "text-muted" };
  const isError = step.status === "error";
  // Tool output / execution result renders as a raw block; narration and the
  // one-line phases render inline.
  const showAsBlock =
    step.phase === "tool_result" ||
    (step.phase === "assistant" && step.text.length > 120);

  return (
    <div className="flex gap-2">
      <span
        className={`shrink-0 font-semibold ${isError ? "text-signal-critical" : meta.cls}`}
      >
        [{meta.label}]
      </span>
      <div className="min-w-0 flex-1">
        {step.tool_name && <span className="text-accent-cyan">{step.tool_name}</span>}
        {showAsBlock ? (
          <pre
            className={`mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-bg-base/60 p-2 ${
              isError ? "text-signal-critical" : "text-muted"
            }`}
          >
            {step.text}
          </pre>
        ) : (
          <span
            className={`${step.tool_name ? "ml-2 " : ""}${
              isError ? "text-signal-critical" : "text-fg"
            } break-words`}
          >
            {step.text}
          </span>
        )}
      </div>
    </div>
  );
}
