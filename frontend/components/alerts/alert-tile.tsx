"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";
import type { Alert } from "@/lib/api";
import { enrichAlertTitle } from "@/components/alerts/alert-title";
import { formatRelative } from "@/lib/utils";

/**
 * Map alert severity → the CSS variable that drives the tile's side
 * stripe. The variables come from globals.css and already adjust per
 * theme, so a single line picks up both light + dark.
 */
const STRIPE_VAR: Record<Alert["severity"], string> = {
  critical: "var(--critical)",
  warning: "var(--warning)",
  info: "var(--info)",
};

const STRIPE_GLOW: Record<Alert["severity"], string> = {
  critical: "rgba(239,68,68,0.45)",
  warning: "rgba(245,158,11,0.40)",
  info: "rgba(var(--accent-rgb),0.35)",
};

interface AlertTileProps {
  alert: Alert;
  onAcknowledge?: () => void;
  onResolve?: () => void;
}

export function AlertTile({
  alert,
  onAcknowledge,
  onResolve,
}: AlertTileProps) {
  const stripe = STRIPE_VAR[alert.severity];
  const glow = STRIPE_GLOW[alert.severity];

  // Markdown preview — trim to a single short paragraph so tiles stay
  // compact. The full body shows up on the detail page.
  const preview = alert.body.length > 240
    ? alert.body.slice(0, 240).trimEnd() + "…"
    : alert.body;

  return (
    <Link
      href={`/alerts/${alert.id}`}
      className="alert-tile group relative block w-full text-left rounded-2xl overflow-hidden"
      style={{
        // The faux-3D look is three layered shadows: an inner top edge
        // for the highlight, a soft drop shadow below the tile, and a
        // colored bloom along the severity stripe so it reads as a
        // glowing inlay rather than a flat rule.
        background: "var(--bg-card)",
        border: "1px solid var(--line)",
        boxShadow: `
          inset 0 1px 0 rgba(255,255,255,0.06),
          inset 5px 0 0 ${stripe},
          inset 6px 0 12px -6px ${glow},
          0 1px 0 rgba(0,0,0,0.25),
          0 8px 24px -12px rgba(0,0,0,0.55),
          -2px 0 18px -8px ${glow}
        `,
        transition: "transform 180ms ease, box-shadow 180ms ease",
      }}
    >
      <div className="relative pl-6 pr-4 py-3.5">
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: stripe }}
          >
            {alert.severity}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted">
            {alert.module}
          </span>
          {alert.occurrence_count > 1 && (
            <span
              className="text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded-md border border-line text-[color:var(--text)]/80"
              title={`This alert has fired ${alert.occurrence_count} times`}
            >
              ×{alert.occurrence_count}
            </span>
          )}
          <span className="text-[10px] text-muted ml-auto">
            {formatRelative(alert.last_seen_at ?? alert.created_at)}
          </span>
        </div>

        <h3 className="font-medium text-[14px] leading-snug text-[color:var(--text)] line-clamp-2">
          {enrichAlertTitle(alert)}
        </h3>

        <div className="text-[13px] text-[color:var(--text)]/65 mt-1.5 line-clamp-3 alert-tile-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Strip block-level styling — we render markdown only so
              // bold / italic / code spans don't show literal **; the
              // tile is a preview, not a document.
              p: ({ children }) => <span>{children} </span>,
              h1: ({ children }) => <span>{children} </span>,
              h2: ({ children }) => <span>{children} </span>,
              h3: ({ children }) => <span>{children} </span>,
              ul: ({ children }) => <span>{children} </span>,
              li: ({ children }) => <span>{children}. </span>,
              code: ({ children }) => (
                <code className="font-mono text-[12px] bg-bg-elevated/60 rounded px-1">
                  {children}
                </code>
              ),
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {preview}
          </ReactMarkdown>
        </div>

        <div className="flex items-center gap-2 mt-3">
          {alert.status === "open" && onAcknowledge && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAcknowledge();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onAcknowledge();
                }
              }}
              className="text-[11px] h-7 px-2.5 rounded-md border border-line text-muted hover:text-[color:var(--text)] hover:bg-bg-elevated/60 flex items-center cursor-pointer"
            >
              Acknowledge
            </span>
          )}
          {alert.status !== "resolved" && onResolve && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onResolve();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onResolve();
                }
              }}
              className="text-[11px] h-7 px-2.5 rounded-md bg-gradient-to-r from-accent-emerald to-accent-cyan text-bg-base flex items-center cursor-pointer"
            >
              Resolve
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted flex items-center gap-1 group-hover:text-[color:var(--text)] transition-colors">
            Open details <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>

      <style jsx>{`
        .alert-tile:hover {
          transform: translateY(-1px);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            inset 5px 0 0 ${stripe},
            inset 6px 0 16px -4px ${glow},
            0 1px 0 rgba(0, 0, 0, 0.25),
            0 14px 28px -14px rgba(0, 0, 0, 0.6),
            -2px 0 28px -6px ${glow} !important;
        }
        .alert-tile :global(.alert-tile-preview p) {
          margin: 0;
        }
      `}</style>
    </Link>
  );
}
