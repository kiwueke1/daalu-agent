"use client";

import { useEffect, useRef, useState } from "react";
import type { Event } from "./api";

/**
 * Live event stream subscribed via the API's /events/stream SSE endpoint.
 * Holds the most recent ``cap`` events in state — paged history lives on
 * the Events page and uses the regular REST list endpoint.
 */
export function useEventStream(opts: { module?: string; cap?: number } = {}) {
  const [events, setEvents] = useState<Event[]>([]);
  const cap = opts.cap ?? 50;
  const moduleFilter = opts.module;
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (moduleFilter) params.set("module", moduleFilter);
    const es = new EventSource(`/api/v1/events/stream?${params}`);
    esRef.current = es;
    es.addEventListener("operational-event", (msg) => {
      try {
        const ev = JSON.parse((msg as MessageEvent).data) as Event;
        setEvents((prev) => [ev, ...prev].slice(0, cap));
      } catch {
        // ignore malformed frames
      }
    });
    return () => es.close();
  }, [moduleFilter, cap]);

  return events;
}

export type RemediationStep = {
  phase: string; // investigate | tool_result | propose | execute | assistant | done
  tool_name: string;
  status: string; // running | ok | error | pending
  text: string;
  ts: string;
};

/**
 * Live execution log for one alert, subscribed via the API's
 * /alerts/{id}/chat/stream SSE endpoint. Accumulates steps (read tools as
 * they run, proposed writes, approved executions + their output) in order
 * so the UI can render them like a terminal while the agent works.
 */
export function useRemediationStream(
  alertId: string | undefined,
  opts: { cap?: number } = {},
) {
  const [steps, setSteps] = useState<RemediationStep[]>([]);
  const cap = opts.cap ?? 300;

  useEffect(() => {
    if (!alertId) return;
    const es = new EventSource(`/api/v1/alerts/${alertId}/chat/stream`);
    es.addEventListener("remediation-step", (msg) => {
      try {
        const step = JSON.parse((msg as MessageEvent).data) as RemediationStep;
        setSteps((prev) => [...prev, step].slice(-cap));
      } catch {
        // ignore malformed frames
      }
    });
    return () => es.close();
  }, [alertId, cap]);

  return steps;
}
