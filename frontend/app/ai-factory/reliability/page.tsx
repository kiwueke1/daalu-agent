"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ReliabilityPanel } from "../components/reliability-panel";
import { FactoryGate, FactoryPageShell } from "../components/factory-page-shell";

/**
 * /ai-factory/reliability — factory-wide NVSentinel auto-remediation posture
 * and cuda-checkpoint status (read-only). Per-card DCGM health (XID/ECC/temp)
 * lives in each GPU's detail view; this page is the whole-floor reliability
 * layer. Owner/provider only.
 */
export default function ReliabilityPage() {
  const overview = useQuery({
    queryKey: ["aiFactory", "overview"],
    queryFn: api.aiFactory.overview,
  });
  const role = overview.data?.role ?? "none";
  const isHardware = role === "owner" || role === "provider";

  return (
    <FactoryPageShell
      title="Reliability"
      subtitle="Automated GPU-fault containment posture: NVSentinel watches the DCGM fault stream (XID / ECC / thermal); cuda-checkpoint status is shown for transparency."
    >
      {!isHardware ? (
        <FactoryGate message="The reliability posture is shown to GPU owners and providers." />
      ) : (
        <ReliabilityPanel />
      )}
    </FactoryPageShell>
  );
}
