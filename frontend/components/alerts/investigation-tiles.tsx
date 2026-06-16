"use client";

import { Children, isValidElement, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code,
  Copy,
  Database,
  FileText,
  Layers,
  ListTree,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import {
  api,
  type Alert,
  type AlertAction,
  type AlertChatMessage,
} from "@/lib/api";

interface InvestigationTilesProps {
  alert: Alert;
}

/**
 * The autonomous-triage surface for a single alert.
 *
 * On mount the component fires POST /alerts/{id}/triage — that
 * endpoint is idempotent server-side, so reopening the page (or
 * concurrent tabs) does not re-spend a model turn. The agent emits
 * exactly three sections (Root cause / Background / Remediation plan)
 * which we slice into the three narrative tiles at the top.
 *
 * Manual-action steps live INSIDE the Remediation plan now — every
 * step is tagged `[system]` (the system will run it on Approve plan)
 * or `[operator]` (the operator must do it themselves, with a copy-
 * able command + a "→ where to run it" line). The previous
 * standalone "What you need to do" tile is gone; that information is
 * called out by yellow highlighting inside the remediation steps.
 *
 * Evidence tiles below populate from the agent's tool calls (logs,
 * events, pod state, deployment, metrics).
 */
export function InvestigationTiles({ alert }: InvestigationTilesProps) {
  const qc = useQueryClient();
  const { data: messages, isLoading } = useQuery({
    queryKey: ["alert-chat", alert.id],
    queryFn: () => api.alerts.chat.list(alert.id),
    refetchOnWindowFocus: false,
  });

  const triage = useMutation({
    mutationFn: (opts: { force?: boolean } = {}) =>
      api.alerts.chat.triage(alert.id, opts),
    onSuccess: (data) => qc.setQueryData(["alert-chat", alert.id], data),
  });

  // Fire the kickoff exactly once per page mount. The backend will
  // no-op if a previous tab already kicked off.
  useEffect(() => {
    if (isLoading) return;
    if (triage.isPending || triage.isSuccess) return;
    const hasAssistant = (messages ?? []).some((m) => m.role === "assistant");
    if (hasAssistant) return;
    triage.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, alert.id]);

  const groups = useMemo(() => groupActions(messages ?? []), [messages]);
  const sections = useMemo(() => parseSections(latestSummary(messages ?? [])), [messages]);

  const triageInFlight = triage.isPending;

  if (isLoading) {
    return (
      <div className="text-[12px] text-muted flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading investigation…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-wider text-muted">
          Investigation
        </h2>
        <button
          type="button"
          onClick={() => triage.mutate({ force: true })}
          disabled={triageInFlight}
          className="text-[11px] h-7 px-2 rounded-md border border-line text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1.5 disabled:opacity-50"
          title="Re-run the autonomous triage pass"
        >
          {triageInFlight ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {triageInFlight ? "Triaging…" : "Re-triage"}
        </button>
      </div>

      {/* Top row: Root cause + Background + Remediation plan all sit
       *  side-by-side as portrait tiles. Any tile expands to span the
       *  full three-column row when opened, giving the remediation
       *  step list + code blocks + Approve button the breathing room
       *  they need without permanently consuming a row of its own. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <NarrativeTile
          title="Root cause"
          subtitle="What broke and why"
          body={sections.rootCause}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          accent="var(--accent)"
          pending={triageInFlight && !sections.rootCause}
          empty="No findings yet — hit Re-triage to start an investigation."
        />
        <NarrativeTile
          title="Background"
          subtitle="Context you may not have"
          body={sections.background}
          icon={<BookOpen className="h-3.5 w-3.5" />}
          accent="var(--info)"
          pending={triageInFlight && !sections.background}
          empty="Background context will appear here once the agent has investigated."
        />
        <RemediationTile
          alert={alert}
          pendingWrites={groups.pendingWrites}
          executedWrites={groups.executedWrites}
          plan={sections.remediationPlan}
          pending={triageInFlight && !sections.remediationPlan}
        />
      </div>

      <h3 className="text-[11px] uppercase tracking-wider text-muted pt-2">
        Evidence
      </h3>

      {/* Square evidence tiles for the diagnostic tool calls. Click any
       *  to expand into a column-spanning panel showing the tool output
       *  with error lines auto-highlighted in red. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
        {ORDER.map((kind) => {
          const group = groups[kind];
          if (!group || group.actions.length === 0) return null;
          return <EvidenceTile key={kind} kind={kind} group={group} />;
        })}
      </div>
    </div>
  );
}

// ── Narrative tile (root cause / background) ────────────────────────────

function NarrativeTile({
  title,
  subtitle,
  body,
  icon,
  accent,
  pending,
  empty,
}: {
  title: string;
  subtitle: string;
  body: string;
  icon: React.ReactNode;
  accent: string;
  pending: boolean;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = !!body && body.trim() !== "—";

  return (
    <div
      className={`narrative-tile rounded-2xl overflow-hidden ${open ? "md:col-span-3" : ""}`}
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--line)",
        boxShadow: `
          inset 4px 0 0 ${accent},
          inset 0 1px 0 rgba(255,255,255,0.06),
          0 1px 0 rgba(0,0,0,0.18),
          0 6px 18px -10px rgba(0,0,0,0.40)
        `,
      }}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        disabled={!hasBody}
        className="w-full text-left px-5 py-4 flex items-center gap-3"
      >
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0"
          style={{
            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
            color: accent,
          }}
        >
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            {subtitle}
          </div>
          <div className="text-[15px] font-semibold leading-tight truncate">
            {title}
          </div>
        </div>
        {hasBody && (
          <span className="text-[11px] text-muted inline-flex items-center gap-1">
            {open ? (
              <>
                Collapse <ChevronDown className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                Open <ChevronRight className="h-3.5 w-3.5" />
              </>
            )}
          </span>
        )}
        {!hasBody && pending && (
          <Loader2 className="h-4 w-4 text-muted animate-spin" />
        )}
      </button>

      {!hasBody && (
        <div className="px-5 pb-4 text-[12px] text-muted">
          {pending ? "Investigating — agent is pulling logs, events and metrics…" : empty}
        </div>
      )}

      {/* Artwork removed in v2 — the closed-state tile is just the
       *  title row above. No illustration, no dead space below. */}

      {open && hasBody && (
        <div
          className="px-5 pb-5"
          style={{ borderTop: "1px solid var(--line)" }}
        >
          <article className="prose prose-sm dark:prose-invert max-w-none investigation-md mt-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </article>
        </div>
      )}

      <style jsx>{`
        .narrative-tile {
          transition:
            transform 180ms ease,
            box-shadow 180ms ease;
        }
        .narrative-tile:hover {
          transform: translateY(-1px);
        }
        :global([data-theme="light"]) .narrative-art {
          mix-blend-mode: multiply;
          opacity: 0.85;
        }
        :global([data-theme="dark"]) .narrative-art,
        :global(html:not([data-theme])) .narrative-art {
          mix-blend-mode: screen;
          opacity: 0.7;
          filter: brightness(1.05);
        }
      `}</style>
    </div>
  );
}

// ── Remediation tile ───────────────────────────────────────────────────
//
// Renders the full step list — system steps and operator steps
// interleaved in whatever order the agent emitted them. Each step is
// tagged either `[system]` or `[operator]`; operator steps get a
// yellow chip, a "→ where to run it" callout, and code blocks with
// per-block copy buttons. The bulk "Approve plan" button at the
// bottom fans out approvals on every pending write action the agent
// proposed.

function RemediationTile({
  alert,
  pendingWrites,
  executedWrites,
  plan,
  pending,
}: {
  alert: Alert;
  pendingWrites: AlertAction[];
  executedWrites: AlertAction[];
  plan: string;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const approveOne = useMutation({
    mutationFn: (actionId: string) => api.alerts.chat.approve(alert.id, actionId),
    onSuccess: (data) => qc.setQueryData(["alert-chat", alert.id], data),
  });
  const rejectOne = useMutation({
    mutationFn: (actionId: string) => api.alerts.chat.reject(alert.id, actionId),
    onSuccess: (data) => qc.setQueryData(["alert-chat", alert.id], data),
  });

  // "Approve plan" runs every pending write in sequence. The backend
  // exposes one approve-per-action endpoint, so the bulk button just
  // fans out and refetches once everything settles.
  const [bulkApproving, setBulkApproving] = useState(false);
  const approvePlan = async () => {
    setBulkApproving(true);
    try {
      for (const a of pendingWrites) {
        await api.alerts.chat.approve(alert.id, a.id);
      }
      qc.invalidateQueries({ queryKey: ["alert-chat", alert.id] });
    } finally {
      setBulkApproving(false);
    }
  };

  // Count operator steps in the rendered plan so we can give the
  // operator a heads-up that the plan has manual work in it.
  const operatorStepCount = useMemo(() => {
    if (!plan) return 0;
    const matches = plan.match(/\[operator\]/gi);
    return matches ? matches.length : 0;
  }, [plan]);

  const accent = "var(--accent)";
  const hasContent =
    !!plan || pendingWrites.length > 0 || executedWrites.length > 0;

  if (!hasContent) {
    return (
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--line)",
          boxShadow: `
            inset 4px 0 0 ${accent},
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 6px 18px -10px rgba(0,0,0,0.40)
          `,
        }}
      >
        <div className="px-5 py-4 flex items-center gap-3">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0"
            style={{
              background: `color-mix(in srgb, ${accent} 18%, transparent)`,
              color: accent,
            }}
          >
            <Wrench className="h-3.5 w-3.5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Plan + manual steps
            </div>
            <div className="text-[15px] font-semibold leading-tight">
              Remediation plan
            </div>
          </div>
          {pending && <Loader2 className="h-4 w-4 text-muted animate-spin" />}
        </div>
        <div className="px-5 pb-4 text-[12px] text-muted">
          {pending
            ? "Investigating — the plan will appear here once the agent has a fix proposal."
            : "No plan yet. Re-triage or ask the chat for next steps."}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`remediation-tile rounded-2xl overflow-hidden ${open ? "md:col-span-3" : ""}`}
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--line)",
        boxShadow: `
          inset 4px 0 0 ${accent},
          inset 0 1px 0 rgba(255,255,255,0.06),
          0 1px 0 rgba(0,0,0,0.18),
          0 6px 18px -10px rgba(0,0,0,0.40)
        `,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-5 py-4 flex items-center gap-3"
      >
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0"
          style={{
            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
            color: accent,
          }}
        >
          <Wrench className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Plan + manual steps
          </div>
          <div className="text-[15px] font-semibold leading-tight truncate">
            Remediation plan
          </div>
        </div>
        <span className="text-[11px] text-muted inline-flex items-center gap-1">
          {open ? (
            <>
              Collapse <ChevronDown className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              Open <ChevronRight className="h-3.5 w-3.5" />
            </>
          )}
        </span>
      </button>

      {!open && (
        <div className="px-5 pb-3">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-muted">
              {pendingWrites.length > 0
                ? `${pendingWrites.length} system action${pendingWrites.length === 1 ? "" : "s"} queued`
                : executedWrites.length > 0
                  ? `${executedWrites.length} action${executedWrites.length === 1 ? "" : "s"} ran`
                  : "Read-only plan"}
            </span>
            {operatorStepCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold"
                style={{ color: "var(--warning)" }}
              >
                <AlertTriangle className="h-3 w-3" />
                {operatorStepCount} need{operatorStepCount === 1 ? "s" : ""} you
              </span>
            )}
          </div>
        </div>
      )}

      {open && (
        <div
          className="px-5 pb-5 space-y-4"
          style={{ borderTop: "1px solid var(--line)" }}
        >
          {/* Approve panel lives ABOVE the markdown so a queued
           *  system action is the first thing the operator sees on
           *  expand — they shouldn't have to scroll a wall of step
           *  text just to find the button the agent told them to
           *  click. */}
          {pendingWrites.length > 0 && (
            <div
              className="rounded-xl p-4 mt-4"
              style={{
                background:
                  "color-mix(in srgb, var(--accent) 10%, var(--bg-elevated))",
                border: "1px solid color-mix(in srgb, var(--accent) 40%, var(--line))",
                boxShadow: "inset 4px 0 0 var(--accent), 0 4px 18px -10px var(--accent-glow)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                <div className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
                  {pendingWrites.length} action{pendingWrites.length === 1 ? "" : "s"} ready to run
                </div>
                <span className="text-[11px] text-muted ml-auto">
                  Mutates cluster state — review before approving.
                </span>
              </div>
              <div className="space-y-2">
                {pendingWrites.map((a) => {
                  const busy = approveOne.isPending || rejectOne.isPending || bulkApproving;
                  return (
                    <div
                      key={a.id}
                      className="rounded-md border border-line bg-bg-base/40 px-3 py-2"
                    >
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono font-semibold">{a.tool_name}</span>
                        <span className="text-muted truncate">
                          {renderArgs(a.tool_input)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-[11px] text-muted flex-1 min-w-0 truncate">
                          {describeAction(a)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => rejectOne.mutate(a.id)}
                          className="h-8 px-3 rounded-md border border-line text-muted hover:text-[color:var(--text)] disabled:opacity-40 inline-flex items-center gap-1.5 text-[12px]"
                        >
                          <X className="h-3.5 w-3.5" /> Reject
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => approveOne.mutate(a.id)}
                          className="h-8 px-3 rounded-md text-bg-base disabled:opacity-40 inline-flex items-center gap-1.5 text-[12px] font-semibold"
                          style={{
                            background:
                              "linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #000))",
                          }}
                        >
                          <Check className="h-3.5 w-3.5" /> Approve & run
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {pendingWrites.length > 1 && (
                <button
                  type="button"
                  disabled={bulkApproving}
                  onClick={approvePlan}
                  className="mt-3 w-full h-10 rounded-lg text-bg-base disabled:opacity-50 inline-flex items-center justify-center gap-2 text-[13px] font-semibold"
                  style={{
                    background:
                      "linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #000))",
                    boxShadow: "0 4px 18px -6px var(--accent-glow)",
                  }}
                >
                  {bulkApproving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Running plan…
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" /> Approve all and run plan
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Executed actions panel: the operator clicked Approve
           *  (or auto-approved reads landed) — show the exact tool
           *  call we fired plus what came back. Lets you confirm the
           *  patch / restart / delete actually happened and see the
           *  cluster's response without digging into the chat rail. */}
          {executedWrites.length > 0 && (
            <ExecutedActionsPanel actions={executedWrites} />
          )}

          {/* Heuristic guardrail: the agent sometimes writes "click
           *  Approve" in the plan but forgets to emit the matching
           *  tool_use, leaving the operator hunting for a button
           *  that can't exist. Surface that gap explicitly so they
           *  know to re-triage. */}
          {pendingWrites.length === 0 && plan && /\bapprov(e|al)\b/i.test(plan) && (
            <div
              className="rounded-xl p-3 text-[12px]"
              style={{
                background: "color-mix(in srgb, var(--warning) 12%, var(--bg-elevated))",
                border: "1px solid color-mix(in srgb, var(--warning) 50%, var(--line))",
                color: "color-mix(in srgb, var(--warning) 80%, var(--text))",
              }}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  The plan references an Approve step, but the agent
                  didn't queue a matching tool call — nothing to run
                  from here. Hit <strong>Re-triage</strong> at the top
                  of Investigation to regenerate a plan with an
                  actionable button, or copy the commands below and run
                  them yourself.
                </span>
              </div>
            </div>
          )}

          {plan && (
            <article className="prose prose-sm dark:prose-invert max-w-none investigation-md remediation-md mt-4">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={remediationMdComponents}
              >
                {plan}
              </ReactMarkdown>
            </article>
          )}
        </div>
      )}

      <style jsx>{`
        .remediation-tile {
          transition: box-shadow 180ms ease;
        }
        :global([data-theme="light"]) .narrative-art {
          mix-blend-mode: multiply;
          opacity: 0.85;
        }
        :global([data-theme="dark"]) .narrative-art,
        :global(html:not([data-theme])) .narrative-art {
          mix-blend-mode: screen;
          opacity: 0.7;
          filter: brightness(1.05);
        }
      `}</style>

      {/* Step-level styling lives in a global block so it can reach
       *  the markdown-rendered <li>s the ReactMarkdown component
       *  emits. */}
      <style jsx global>{`
        .remediation-md ol,
        .remediation-md ul {
          padding-left: 0;
          margin: 0;
          list-style: none;
          counter-reset: rem-step;
        }
        .remediation-md > ol > li,
        .remediation-md > ul > li {
          counter-increment: rem-step;
          position: relative;
          padding: 0.65em 0.85em 0.75em 2.4em;
          margin: 0.5em 0;
          border-radius: 10px;
          background: var(--bg-elevated);
          border: 1px solid var(--line);
        }
        .remediation-md > ol > li::before {
          content: counter(rem-step);
          position: absolute;
          left: 0.6em;
          top: 0.65em;
          width: 1.45em;
          height: 1.45em;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: color-mix(in srgb, var(--accent) 22%, transparent);
          color: var(--accent);
          font-size: 0.78em;
          font-weight: 700;
        }
        .remediation-md .step-operator {
          background: color-mix(in srgb, var(--warning) 10%, var(--bg-elevated));
          border-color: color-mix(in srgb, var(--warning) 60%, var(--line));
          box-shadow: inset 3px 0 0 var(--warning);
        }
        .remediation-md .step-operator::before {
          background: var(--warning);
          color: var(--bg-base);
        }
        .remediation-md .step-system {
          background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
          border-color: color-mix(in srgb, var(--accent) 28%, var(--line));
        }
        .remediation-md .step-tag {
          display: inline-flex;
          align-items: center;
          gap: 0.3em;
          font-size: 0.72em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 0.15em 0.5em;
          border-radius: 999px;
          margin-right: 0.55em;
          vertical-align: middle;
        }
        .remediation-md .step-tag-operator {
          background: var(--warning);
          color: var(--bg-base);
        }
        .remediation-md .step-tag-system {
          background: color-mix(in srgb, var(--accent) 22%, transparent);
          color: var(--accent);
          border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
        }
        .remediation-md .step-where {
          display: block;
          margin: 0.45em 0 0.25em;
          padding: 0.35em 0.55em;
          font-size: 0.85em;
          background: color-mix(in srgb, var(--warning) 14%, transparent);
          border-left: 2px solid var(--warning);
          border-radius: 4px;
          color: color-mix(in srgb, var(--warning) 85%, var(--text));
        }
        .remediation-md p {
          margin: 0.25em 0;
        }
        .remediation-md code {
          font-family: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace;
          font-size: 0.9em;
          background: var(--bg-base);
          border: 1px solid var(--line);
          padding: 0.05em 0.35em;
          border-radius: 4px;
        }
        .remediation-md .code-block-wrap {
          position: relative;
          margin: 0.5em 0;
          border-radius: 8px;
          overflow: hidden;
          background: var(--bg-base);
          border: 1px solid var(--line);
        }
        .remediation-md .code-block-wrap pre {
          margin: 0;
          padding: 0.7em 3.4em 0.7em 0.85em;
          font-family: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace;
          font-size: 0.85em;
          white-space: pre-wrap;
          word-break: break-word;
          background: transparent;
          border: none;
        }
        .remediation-md .code-block-wrap pre code {
          background: transparent;
          border: none;
          padding: 0;
          font-size: inherit;
          color: inherit;
        }
        .remediation-md .code-block-copy {
          position: absolute;
          top: 0.4em;
          right: 0.4em;
          height: 1.7em;
          padding: 0 0.6em;
          display: inline-flex;
          align-items: center;
          gap: 0.3em;
          border-radius: 5px;
          background: color-mix(in srgb, var(--accent) 18%, transparent);
          border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
          color: var(--accent);
          font-size: 0.75em;
          font-weight: 600;
          cursor: pointer;
          transition:
            background 140ms ease,
            color 140ms ease;
        }
        .remediation-md .code-block-copy:hover {
          background: color-mix(in srgb, var(--accent) 32%, transparent);
          color: var(--bg-base);
        }
        .remediation-md .code-block-copy.copied {
          background: var(--accent);
          color: var(--bg-base);
          border-color: var(--accent);
        }
      `}</style>
    </div>
  );
}

// ── ReactMarkdown component overrides for the Remediation tile ──────────

/**
 * Walk a React children tree and collect its raw text. Used to peek
 * at a list-item's content so we can decide whether it's a
 * [system] or [operator] step.
 */
function flattenText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: unknown };
    return flattenText(props.children);
  }
  return "";
}

/**
 * Strip the leading `**[operator]**` / `**[system]**` token off a
 * list item's first child so the badge we render doesn't double up
 * with the marker text. Returns the modified children tree.
 */
function stripStepMarker(children: React.ReactNode): React.ReactNode {
  const arr = Children.toArray(children);
  for (let i = 0; i < arr.length; i++) {
    const node = arr[i];
    if (typeof node === "string") {
      const stripped = node.replace(
        /^\s*\*?\*?\[(operator|system)\]\*?\*?\s*[—\-:]?\s*/i,
        ""
      );
      if (stripped !== node) {
        arr[i] = stripped;
        return arr;
      }
      // Empty after strip — keep walking.
      if (node.trim() === "") continue;
      return arr;
    }
    if (isValidElement(node)) {
      // The marker is usually wrapped in <strong>**[operator]**</strong>
      // by remark-gfm; check if this element's text is exactly the
      // marker and drop it.
      const inner = flattenText((node.props as { children?: unknown }).children).trim();
      if (/^\[(operator|system)\]$/i.test(inner)) {
        // Also drop a trailing "—" or ":" separator that follows the
        // marker, so we don't get a dangling em-dash before the body.
        const next = arr[i + 1];
        if (typeof next === "string") {
          arr[i + 1] = next.replace(/^\s*[—\-:]\s*/, "");
        }
        arr.splice(i, 1);
        return arr;
      }
    }
    return arr;
  }
  return arr;
}

/**
 * react-markdown v9 dropped the `inline` prop on the `code` component
 * override, so we can no longer distinguish inline vs fenced code from
 * inside the `code` handler. The correct hook now is the `pre` element:
 * fenced code blocks are wrapped in `<pre><code>…</code></pre>`, while
 * inline backticks emit a bare `<code>` with no `<pre>` parent. We
 * therefore put the copy-button affordance on the `pre` override and
 * leave `code` as a plain inline span — otherwise every `NET_ADMIN` /
 * `delete_pod` / `o-hm0` token written with single-backticks would
 * render as a full-width copy-button block, which is what the user
 * was seeing.
 */
function PreWithCopy({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(flattenText(children)).replace(/\n$/, "");
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // No clipboard permission — degrade gracefully.
    }
  };
  return (
    <div className="code-block-wrap">
      <pre>{children}</pre>
      <button
        type="button"
        onClick={onCopy}
        className={`code-block-copy ${copied ? "copied" : ""}`}
        title="Copy to clipboard"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" /> Copy
          </>
        )}
      </button>
    </div>
  );
}

function InlineCode({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return <code className={className}>{children}</code>;
}

function RemediationListItem({ children }: { children?: React.ReactNode }) {
  const text = flattenText(children);
  const isOperator = /\[operator\]/i.test(text);
  const isSystem = /\[system\]/i.test(text);
  const cls = isOperator
    ? "step-operator"
    : isSystem
      ? "step-system"
      : "";
  const stripped = isOperator || isSystem ? stripStepMarker(children) : children;
  return (
    <li className={cls}>
      {(isOperator || isSystem) && (
        <span
          className={`step-tag ${
            isOperator ? "step-tag-operator" : "step-tag-system"
          }`}
        >
          {isOperator ? (
            <>
              <AlertTriangle className="h-3 w-3" /> You
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" /> System
            </>
          )}
        </span>
      )}
      {stripped}
    </li>
  );
}

/**
 * Wrap a paragraph that starts with "→" in the step-where pill so the
 * "where to run this" line pops visually inside a [operator] step.
 * Lines that don't start with → render as normal <p>s.
 */
function RemediationParagraph({ children }: { children?: React.ReactNode }) {
  const text = flattenText(children).trim();
  if (text.startsWith("→")) {
    return <span className="step-where">{children}</span>;
  }
  return <p>{children}</p>;
}

const remediationMdComponents = {
  // Inline `code` is rendered as a plain span; fenced code blocks
  // come in as <pre><code>…</code></pre> and our PreWithCopy override
  // adds the Copy button + chrome around them.
  code: InlineCode,
  pre: PreWithCopy,
  li: RemediationListItem,
  p: RemediationParagraph,
} as Parameters<typeof ReactMarkdown>[0]["components"];

// ── Evidence tiles (logs, events, etc.) ─────────────────────────────────

const ORDER: EvidenceKind[] = [
  "logs",
  "events",
  "pod",
  "deployment",
  "metrics",
  "cloud_compute",
  "cloud_db",
  "cloud_function",
  "external",
];

const KIND_META: Record<
  EvidenceKind,
  {
    title: string;
    icon: React.ReactNode;
    accent: string;
    artwork?: string;
  }
> = {
  logs: {
    title: "Logs",
    icon: <FileText className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/logs.png",
  },
  events: {
    title: "Cluster events",
    icon: <ListTree className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/cluster_events.png",
  },
  pod: {
    // "Resource state" rather than "Pod state" — this tile now covers
    // any inspected resource (a k8s pod via describe_pod, but the system
    // also reasons over cloud VMs, network devices, BMCs), so the k8s-
    // specific label no longer fits.
    title: "Resource state",
    icon: <Layers className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/pod_state.png",
  },
  deployment: {
    title: "Deployment / rollout",
    icon: <TerminalSquare className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/deployment.png",
  },
  metrics: {
    title: "Metrics",
    icon: <Activity className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/prom_metrics.png",
  },
  cloud_compute: {
    title: "Cloud instances",
    icon: <Server className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
  },
  cloud_db: {
    title: "Cloud databases",
    icon: <Database className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
  },
  cloud_function: {
    title: "Serverless functions",
    icon: <Code className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
  },
  external: {
    title: "External API",
    icon: <Cloud className="h-3.5 w-3.5" />,
    accent: "var(--accent)",
    artwork: "/assets/tiles/external_api.png",
  },
};

function EvidenceTile({
  kind,
  group,
}: {
  kind: EvidenceKind;
  group: EvidenceGroup;
}) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[kind];
  const count = group.actions.length;
  return (
    <SquareTile
      icon={meta.icon}
      artwork={meta.artwork}
      title={meta.title}
      accent={meta.accent}
      countLabel={`${count} call${count === 1 ? "" : "s"} collected`}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div className="space-y-3">
        {group.actions.map((a) => (
          <details
            key={a.id}
            open
            className="rounded-md border border-line bg-bg-elevated/50"
          >
            <summary className="cursor-pointer px-3 py-1.5 text-[11px] flex items-center gap-2">
              <span className="font-mono">{a.tool_name}</span>
              <span className="text-muted truncate">
                {renderArgs(a.tool_input)}
              </span>
              <span
                className="ml-auto text-[10px] uppercase tracking-wider"
                style={{
                  color:
                    a.status === "failed"
                      ? "var(--critical)"
                      : "var(--accent)",
                }}
              >
                {a.status}
              </span>
            </summary>
            <HighlightedLog
              content={a.result_output || a.result_error || "(empty)"}
              variant={a.status === "failed" ? "error" : "normal"}
            />
          </details>
        ))}
      </div>
    </SquareTile>
  );
}

/**
 * Tool-output panel that lights up lines matching common error
 * keywords in red. The model can't tag specific lines (evidence tiles
 * render directly from tool stdout), so we lean on a regex over each
 * line — ERROR / WARN / FATAL / OOMKilled / CrashLoopBackOff /
 * Traceback / HTTP 4xx-5xx / "connection refused" etc.
 *
 * Conservative on purpose: we don't want to redden a benign info line
 * just because it mentions "error code 0" — the regex requires a
 * keyword that's actually a status, not arbitrary substring matches.
 */
function HighlightedLog({
  content,
  variant,
}: {
  content: string;
  variant: "normal" | "error";
}) {
  const lines = content.split("\n");
  return (
    <pre
      className={`px-3 py-2 m-0 font-mono whitespace-pre-wrap break-words text-[11px] max-h-[320px] overflow-auto border-t border-line ${
        variant === "error" ? "log-pre-error" : "log-pre-normal"
      }`}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={isErrorLine(line) ? "log-line-error" : undefined}
        >
          {line || " "}
        </div>
      ))}
      <style jsx>{`
        .log-line-error {
          color: var(--critical);
          font-weight: 500;
        }
        .log-pre-error {
          color: color-mix(in srgb, var(--critical) 90%, var(--text));
        }
      `}</style>
    </pre>
  );
}

// Recognised "this looks like a problem" patterns. Anchored to word
// boundaries so we don't redden every line that happens to contain
// the substring "Failed" inside a noun.
const ERROR_KEYWORDS =
  /\b(ERROR|ERR|WARN|WARNING|FATAL|CRITICAL|PANIC|FAILED?|FAILURE|EXCEPTION|TRACEBACK|OOMKilled|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|ImagePullErr|CreateContainerError|ContainerCannotRun|Evicted|NodeNotReady|BackOff|Killed)\b/;
const HTTP_FAIL = /\b(HTTP\/\S+\s+)?[45]\d{2}\b/;
const NETWORK_FAIL = /\b(connection refused|connection timed out|no route to host|name or service not known|max retries exceeded|i\/o timeout|context deadline exceeded)\b/i;

function isErrorLine(line: string): boolean {
  if (!line) return false;
  return ERROR_KEYWORDS.test(line) || HTTP_FAIL.test(line) || NETWORK_FAIL.test(line);
}

// ── Square evidence tile ──────────────────────────────────────────────

function SquareTile({
  icon,
  artwork,
  title,
  accent,
  countLabel,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  artwork?: string;
  title: string;
  accent: string;
  countLabel: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`square-tile rounded-xl overflow-hidden ${
        open ? "col-span-2 md:col-span-3 xl:col-span-4" : ""
      }`}
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--line)",
        boxShadow: `
          inset 4px 0 0 ${accent},
          inset 0 1px 0 rgba(255,255,255,0.06),
          0 1px 0 rgba(0,0,0,0.18),
          0 6px 18px -10px rgba(0,0,0,0.40)
        `,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className={
          open
            ? "w-full text-left flex items-center gap-2 px-4 py-3"
            : // Closed state — short, centered card. The icon + title +
              // count sit centered horizontally and vertically so the
              // tile reads at a glance without the old aspect-square
              // dead space below the artwork.
              "w-full text-center flex flex-col items-center justify-center gap-1.5 px-4 py-5 min-h-[96px]"
        }
      >
        <span
          className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0"
          style={{
            background: "color-mix(in srgb, var(--accent) 16%, transparent)",
            color: accent,
          }}
        >
          {icon}
        </span>
        {open ? (
          <>
            <span className="text-[12px] font-medium">{title}</span>
            <span className="text-[11px] text-muted">· {countLabel}</span>
            <span className="ml-auto text-muted">
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </>
        ) : (
          <>
            <div className="text-[13px] font-semibold leading-tight">{title}</div>
            <div className="text-[10px] text-muted">{countLabel}</div>
          </>
        )}
      </button>
      {open && <div className="px-3 pb-3 pt-0">{children}</div>}
      <style jsx>{`
        .square-tile {
          transition:
            transform 160ms ease,
            box-shadow 160ms ease;
        }
        .square-tile:hover {
          transform: translateY(-1px);
        }
        :global([data-theme="light"]) .tile-artwork {
          mix-blend-mode: multiply;
          opacity: 0.92;
        }
        :global([data-theme="dark"]) .tile-artwork,
        :global(html:not([data-theme])) .tile-artwork {
          mix-blend-mode: screen;
          opacity: 0.85;
          filter: brightness(1.05);
        }
      `}</style>
    </div>
  );
}

// ── Helpers / extraction logic ─────────────────────────────────────────

type EvidenceKind =
  | "logs"
  | "events"
  | "pod"
  | "deployment"
  | "metrics"
  | "external"
  | "cloud_compute"
  | "cloud_db"
  | "cloud_function";

interface EvidenceGroup {
  actions: AlertAction[];
}

interface Groups extends Record<EvidenceKind, EvidenceGroup | undefined> {
  pendingWrites: AlertAction[];
  executedWrites: AlertAction[];
}

const KIND_OF: Record<string, EvidenceKind> = {
  // k8s read tools
  get_pod_logs: "logs",
  query_loki: "logs",
  get_pod_events: "events",
  list_pods: "events",
  describe_pod: "pod",
  get_deployment: "deployment",
  rollout_history: "deployment",
  query_prometheus: "metrics",
  call_external_api: "external",
  // AWS read tools
  aws_describe_instances: "cloud_compute",
  aws_get_cloudwatch_logs: "logs",
  aws_query_cloudwatch_metric: "metrics",
  aws_describe_rds_instances: "cloud_db",
  aws_describe_lambda: "cloud_function",
  // GCP read tools
  gcp_list_instances: "cloud_compute",
  gcp_query_logging: "logs",
  gcp_query_monitoring: "metrics",
  gcp_describe_sql_instance: "cloud_db",
  gcp_describe_function: "cloud_function",
  // Azure read tools
  azure_list_vms: "cloud_compute",
  azure_query_log_analytics: "logs",
  azure_query_metrics: "metrics",
  azure_describe_sql_db: "cloud_db",
  azure_describe_function: "cloud_function",
};

const WRITE_TOOL_NAMES = new Set([
  "rollout_undo",
  "scale_deployment",
  "restart_deployment",
  "delete_pod",
  "patch_resource",
]);

function isWriteTool(name: string, requiresApproval: boolean): boolean {
  if (WRITE_TOOL_NAMES.has(name)) return true;
  // call_external_api with a non-GET method shows up as
  // requires_approval=true at action-creation time.
  return requiresApproval;
}

function groupActions(messages: AlertChatMessage[]): Groups {
  const out: Groups = {
    logs: undefined,
    events: undefined,
    pod: undefined,
    deployment: undefined,
    metrics: undefined,
    external: undefined,
    cloud_compute: undefined,
    cloud_db: undefined,
    cloud_function: undefined,
    pendingWrites: [],
    executedWrites: [],
  };
  for (const m of messages) {
    for (const a of m.actions || []) {
      if (a.status === "pending" && a.requires_approval) {
        out.pendingWrites.push(a);
        continue;
      }
      // Write tools that have run (executed / failed / rejected) get
      // bundled into their own "Actions ran" section inside the
      // Remediation tile, so the operator can see the kubectl/cloud
      // call we fired plus the API's response. Read-tool calls land
      // in the evidence tiles below as before.
      if (
        isWriteTool(a.tool_name, a.requires_approval) &&
        a.status !== "pending"
      ) {
        out.executedWrites.push(a);
        continue;
      }
      const k = KIND_OF[a.tool_name];
      if (!k) continue;
      out[k] ??= { actions: [] };
      out[k]!.actions.push(a);
    }
  }
  return out;
}

function latestSummary(messages: AlertChatMessage[]): string {
  // The triage summary is the most recent assistant message that
  // carries the three `## Root cause / Background / Remediation
  // plan` section headers. After approval the agent posts follow-up
  // notes (e.g. "patch applied, pod recreated"); those are useful
  // but they do NOT replace the triage summary — if we treated them
  // as the source for the three top tiles, rootCause / background /
  // plan would all go empty and the click-to-expand buttons would
  // disable. So we walk the transcript backwards looking for a
  // header-carrying assistant message first, falling back to the
  // bare-text latest only when no triage has been produced yet.
  const HEADER_RE =
    /^##\s+(root cause|background|context|remediation|plan)\b/im;
  let fallback = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const body = m.content.trim();
    if (!body) continue;
    if (HEADER_RE.test(body)) return m.content;
    if (!fallback) fallback = m.content;
  }
  return fallback;
}

/**
 * Slice the agent's final markdown into the three expected sections.
 *
 * The system prompt locks the model to exactly three `## ` headers in
 * a fixed order: Root cause / Background / Remediation plan. We still
 * parse forgivingly — match by case-insensitive header text so a
 * stray capitalisation doesn't blank the tile. Any content before
 * the first header is discarded. Manual steps now live inside the
 * Remediation plan section (tagged `[operator]`); legacy
 * "What you need to do" or "Likely operator questions" sections from
 * messages generated before the prompt change are dropped silently.
 */
interface Sections {
  rootCause: string;
  background: string;
  remediationPlan: string;
}

function parseSections(md: string): Sections {
  const out: Sections = {
    rootCause: "",
    background: "",
    remediationPlan: "",
  };
  if (!md) return out;
  // Split on lines that start with "## " so we get
  // [pre, header1, body1, header2, body2, ...].
  const parts = md.split(/^##\s+(.+)$/m);
  let manualBody = "";
  for (let i = 1; i < parts.length; i += 2) {
    const header = (parts[i] || "").trim().toLowerCase();
    const body = (parts[i + 1] || "").trim();
    if (header.startsWith("root cause")) out.rootCause = body;
    else if (header.startsWith("background") || header.startsWith("context"))
      out.background = body;
    else if (header.startsWith("remediation") || header.startsWith("plan"))
      out.remediationPlan = body;
    else if (
      header.startsWith("what you need to do") ||
      header.startsWith("operator") ||
      header.startsWith("manual") ||
      header.startsWith("you need")
    ) {
      // Legacy bucket — keep the body so we can append it to the
      // remediation plan if the new section is empty.
      manualBody = body;
    }
    // Evidence is rendered from tool calls. "Likely operator
    // questions" and any other stray section is dropped.
  }
  // Back-compat: if a message was generated before the prompt change,
  // it'll have a separate "What you need to do" section. Fold it back
  // into the Remediation plan body so the new tile still renders it.
  if (manualBody && !/\[operator\]/i.test(out.remediationPlan)) {
    out.remediationPlan = out.remediationPlan
      ? `${out.remediationPlan}\n\n${manualBody}`
      : manualBody;
  }
  return out;
}

function renderArgs(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) =>
      typeof v === "string" ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`
    )
    .join(" ");
}

/**
 * One-line "what this action will do" summary for the Approve panel,
 * keyed off the tool name so the operator doesn't have to mentally
 * translate the raw kwargs into impact ("patch_resource …" alone is
 * opaque without context).
 */
/**
 * Render the post-Approve "Actions ran" panel — one card per executed
 * write tool, expanded by default so the operator sees the kubectl /
 * cloud call we actually fired and whatever stdout / error message
 * came back. Failed actions are flagged red so a botched patch can't
 * hide behind a green checkmark.
 */
function ExecutedActionsPanel({ actions }: { actions: AlertAction[] }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--line)",
        boxShadow: "inset 4px 0 0 var(--accent)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <TerminalSquare className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
        <div
          className="text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--accent)" }}
        >
          {actions.length} action{actions.length === 1 ? "" : "s"} ran
        </div>
        <span className="text-[11px] text-muted ml-auto">
          Outputs returned from the cluster / cloud API.
        </span>
      </div>
      <div className="space-y-2">
        {actions.map((a) => (
          <details
            key={a.id}
            open
            className="rounded-md border border-line bg-bg-base/40"
          >
            <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-[12px]">
              <span className="font-mono font-semibold">{a.tool_name}</span>
              <span className="text-muted truncate flex-1 min-w-0">
                {renderArgs(a.tool_input)}
              </span>
              <span
                className="text-[10px] uppercase tracking-wider font-semibold shrink-0"
                style={{
                  color:
                    a.status === "failed"
                      ? "var(--critical)"
                      : a.status === "rejected"
                        ? "var(--muted)"
                        : "var(--accent)",
                }}
              >
                {a.status}
              </span>
            </summary>
            <div className="border-t border-line">
              <HighlightedLog
                content={a.result_error || a.result_output || "(no output captured)"}
                variant={a.status === "failed" ? "error" : "normal"}
              />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function describeAction(a: AlertAction): string {
  const i = a.tool_input as Record<string, unknown>;
  const ns = typeof i.namespace === "string" ? i.namespace : "?";
  const name = typeof i.name === "string" ? i.name : "?";
  switch (a.tool_name) {
    case "rollout_undo":
      return `Roll deployment ${ns}/${name} back to its previous revision.`;
    case "scale_deployment":
      return `Scale ${ns}/${name} to ${i.replicas} replicas.`;
    case "restart_deployment":
      return `Rolling restart of deployment ${ns}/${name}.`;
    case "delete_pod":
      return `Delete pod ${ns}/${name}; the controller reschedules a replacement.`;
    case "patch_resource": {
      const kind = typeof i.kind === "string" ? i.kind : "resource";
      return `Strategic-merge patch ${kind.toLowerCase()} ${ns}/${name}.`;
    }
    case "call_external_api":
      return `${String(i.method ?? "GET").toUpperCase()} ${i.provider}${i.path ?? ""}`;
    default:
      return "Mutates cluster state — runs on approval.";
  }
}
