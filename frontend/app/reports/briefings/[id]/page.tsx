"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, FileText, Link2, Check } from "lucide-react";
import { api } from "@/lib/api";

export default function BriefingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [copied, setCopied] = useState(false);

  const { data: briefing, isLoading, error } = useQuery({
    queryKey: ["briefing", id],
    queryFn: () => api.briefings.get(id),
    enabled: !!id,
  });

  const copyPermalink = async () => {
    if (typeof window === "undefined") return;
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isLoading) {
    return <div className="text-sm text-muted">Loading briefing…</div>;
  }

  if (error || !briefing) {
    return (
      <div className="space-y-4 max-w-[1000px]">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-[color:var(--text)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Reports
        </Link>
        <div className="rounded-xl border border-line bg-bg-card p-6 text-sm text-muted">
          Briefing not found.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[1000px]">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/reports"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-[color:var(--text)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Reports
        </Link>
        <button
          type="button"
          onClick={copyPermalink}
          className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-muted hover:text-[color:var(--text)] hover:bg-bg-elevated/60 transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Link2 className="h-3.5 w-3.5" /> Copy permalink
            </>
          )}
        </button>
      </div>

      <article className="gradient-border p-6 lg:p-8 bg-hero-grad">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent-blue mb-2">
          <FileText className="h-3.5 w-3.5" /> {briefing.channel} ·{" "}
          {briefing.coverage_date}
        </div>
        <h1 className="text-2xl font-semibold mb-3">{briefing.title}</h1>
        <p className="text-[color:var(--text)]/70 mb-4">{briefing.summary}</p>
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {briefing.body_markdown}
          </ReactMarkdown>
        </div>
      </article>

      {briefing.source_event_ids && briefing.source_event_ids.length > 0 && (
        <section className="rounded-xl border border-line bg-bg-card p-4">
          <h3 className="text-xs uppercase tracking-wider text-muted mb-2">
            Cited events
          </h3>
          <p className="text-sm text-muted">
            {briefing.source_event_ids.length} event
            {briefing.source_event_ids.length === 1 ? "" : "s"} fed this briefing.
            Open the{" "}
            <Link href="/reports?tab=query" className="text-accent-blue hover:underline">
              Query tab
            </Link>{" "}
            to inspect them.
          </p>
        </section>
      )}
    </div>
  );
}
