"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Sparkles,
  RotateCcw,
  AlertTriangle,
  ListChecks,
  Activity,
  Gauge,
  FileText,
  ChevronDown,
  ArrowUpRight,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";

type Tone = "critical" | "warning" | "accent" | "blue" | "muted";

interface Section {
  title: string;
  content: string;
  items: number;
}

/**
 * The daily AI briefing, rendered as a compact header + a grid of
 * clickable section tiles. Each tile shows a one-glance preview (item
 * count / first line); clicking expands it in place to reveal the full
 * section. This replaces the old "dump the entire markdown body inline"
 * layout, which buried the signal in a wall of text.
 */
export function HeroBriefing({ channel = "infra" }: { channel?: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["briefing", "latest", channel],
    queryFn: () => api.briefings.latest(channel),
    retry: false,
  });

  const generate = useMutation({
    mutationFn: () => api.briefings.generate(channel),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["briefing"] }),
  });

  const sections = data ? parseSections(data.body_markdown) : [];
  const metrics = data ? Object.entries(data.metrics ?? {}) : [];

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="gradient-border p-6 lg:p-7 bg-hero-grad relative overflow-hidden"
    >
      <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-accent-blue/20 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -left-12 h-72 w-72 rounded-full bg-accent-violet/20 blur-3xl pointer-events-none" />

      <div className="relative">
        {/* Header row */}
        <div className="flex items-center justify-between mb-3">
          <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-accent-blue">
            <Sparkles className="h-3 w-3 animate-shimmer" /> AI briefing · {channel}
            {data?.coverage_date && (
              <span className="text-muted normal-case tracking-normal ml-1">
                · {data.coverage_date}
              </span>
            )}
          </span>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="text-xs flex items-center gap-1 text-muted hover:text-[color:var(--text)]"
          >
            <RotateCcw
              className={`h-3.5 w-3.5 ${generate.isPending ? "animate-spin" : ""}`}
            />
            Regenerate
          </button>
        </div>

        {isLoading && <div className="animate-shimmer text-muted">Loading…</div>}

        {!data && !isLoading && (
          <div>
            <h2 className="text-2xl font-semibold leading-tight mb-3">
              No briefing yet for the {channel} channel.
            </h2>
            <p className="text-[color:var(--text)]/70 max-w-2xl">
              Briefings are generated daily by the scheduler. To generate one
              now, click{" "}
              <span className="text-[color:var(--text)]">Regenerate</span>. To
              feed real data in, configure an integration on the Integrations
              page or POST events to <code>/api/v1/events</code>.
            </p>
          </div>
        )}

        {data && (
          <>
            {/* Summary — the one-line headline, kept readable not giant */}
            <h2 className="text-lg lg:text-xl leading-snug font-semibold tracking-tight mb-4 max-w-4xl">
              {data.summary || data.title}
            </h2>

            {/* Metric stat chips */}
            {metrics.length > 0 && (
              <div className="flex flex-wrap gap-2.5 mb-5">
                {metrics.map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-baseline gap-2 rounded-lg border border-line bg-bg-elevated/50 px-3 py-1.5"
                  >
                    <span className="text-lg font-semibold leading-none tabular-nums">
                      {String(v)}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {k.replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Section tiles */}
            {sections.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                {sections.map((s, i) => (
                  <SectionTile key={i} section={s} />
                ))}
              </div>
            ) : (
              // Fallback: no parseable sections → render the body as before.
              <article className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {data.body_markdown}
                </ReactMarkdown>
              </article>
            )}

            {data.id && (
              <div className="mt-4">
                <Link
                  href={`/reports/briefings/${data.id}`}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-[color:var(--text)] transition-colors"
                >
                  View full briefing <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </motion.section>
  );
}

/**
 * One collapsible section card. Collapsed it shows an icon, title, and a
 * one-line preview (item count or first line). Clicking reveals the full
 * section markdown in place.
 */
function SectionTile({ section }: { section: Section }) {
  const [open, setOpen] = useState(false);
  const meta = toneFor(section.title);
  const Icon = meta.icon;

  return (
    <div
      className={`surface relative overflow-hidden transition-colors ${
        open ? "ring-1 ring-[color:var(--accent-soft)]" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-4 flex items-start gap-3 group"
      >
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: meta.bg, color: meta.color }}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-[color:var(--text)]">
              {section.title}
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {section.items > 0 && (
                <span
                  className="text-[10px] font-medium rounded-full px-2 py-0.5"
                  style={{ background: meta.bg, color: meta.color }}
                >
                  {section.items}
                </span>
              )}
              <ChevronDown
                className={`h-4 w-4 text-muted transition-transform duration-200 ${
                  open ? "rotate-180" : ""
                }`}
              />
            </span>
          </div>
          {!open && (
            <p className="mt-1 text-xs text-muted line-clamp-2">
              {previewOf(section)}
            </p>
          )}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-0">
              <div className="border-t border-line pt-3 prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-li:my-0.5 prose-ul:my-1">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {section.content}
                </ReactMarkdown>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- helpers ---------- */

/**
 * Split a briefing's markdown body into sections. Recognises both
 * markdown headings (`## Title`) and bold-only lines acting as headings
 * (`**Title**`). Everything before the first heading is ignored (it's
 * usually the summary, already shown above).
 */
function parseSections(md: string): Section[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const sections: Section[] = [];
  let cur: Section | null = null;
  const headingRe = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/;
  const boldHeadingRe = /^\s*\*\*(.+?)\*\*\s*:?\s*$/;

  for (const line of lines) {
    let title: string | null = null;
    const h = line.match(headingRe);
    if (h) {
      title = h[1].replace(/[*_`#]/g, "").trim();
    } else {
      const b = line.match(boldHeadingRe);
      if (b) title = b[1].replace(/[*_`]/g, "").trim();
    }

    if (title) {
      cur = { title, content: "", items: 0 };
      sections.push(cur);
    } else if (cur) {
      cur.content += (cur.content ? "\n" : "") + line;
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) cur.items += 1;
    }
  }

  return sections.filter((s) => s.content.trim().length > 0 || s.items > 0);
}

function previewOf(s: Section): string {
  if (s.items > 0) {
    // First list item, cleaned of markdown bullet syntax.
    const first = s.content
      .split(/\r?\n/)
      .find((l) => /^\s*([-*+]|\d+\.)\s+/.test(l));
    if (first) {
      return first
        .replace(/^\s*([-*+]|\d+\.)\s+/, "")
        .replace(/[*_`]/g, "")
        .trim();
    }
  }
  const firstLine = s.content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine ?? "").replace(/[*_`#>]/g, "").trim();
}

/**
 * Pick an icon + colour tone for a section, by keyword in its title.
 */
function toneFor(title: string): {
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  color: string;
  bg: string;
} {
  const t = title.toLowerCase();
  const make = (
    icon: React.ComponentType<{ className?: string }>,
    color: string,
    bg: string,
    tone: Tone
  ) => ({ icon, color, bg, tone });

  if (/(incident|alert|critical|issue|outage)/.test(t))
    return make(AlertTriangle, "var(--critical)", "rgba(248,113,113,0.12)", "critical");
  if (/(recommend|action|next step|remediat|fix)/.test(t))
    return make(ListChecks, "var(--accent)", "var(--accent-soft)", "accent");
  if (/(capacity|cost|budget|spend|usage)/.test(t))
    return make(Gauge, "var(--text)", "rgba(255,255,255,0.06)", "muted");
  if (/(24h|last|activity|log|summary|change|event)/.test(t))
    return make(Activity, "var(--accent-blue, #6aa8ff)", "rgba(106,168,255,0.12)", "blue");
  return make(FileText, "var(--text)", "rgba(255,255,255,0.06)", "muted");
}
