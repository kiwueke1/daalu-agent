"use client";

/**
 * Standalone cluster-tunnel onboarding workflow.
 *
 * Reachable directly at `/onboarding/cluster` for operators who only
 * want to set up the VPN side without walking through the full
 * integrations wizard. Renders the same <ClusterWorkflow /> component
 * the general wizard embeds, so the flow is identical — just framed
 * as its own page here.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Boxes, ChevronLeft } from "lucide-react";
import { ClusterWorkflow } from "@/components/onboarding/cluster-workflow";

export default function ClusterOnboardingPage() {
  const router = useRouter();
  return (
    <div className="space-y-6 max-w-[860px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/onboarding"
            className="text-[11px] uppercase tracking-wider text-muted hover:text-fg inline-flex items-center gap-1"
          >
            <ChevronLeft className="h-3 w-3" /> Onboarding
          </Link>
          <h1 className="text-2xl font-semibold flex items-center gap-2 mt-1">
            <Boxes className="h-5 w-5 text-accent-cyan" /> Cluster tunnel onboarding
          </h1>
          <p className="text-muted text-sm mt-1">
            Stand up a WireGuard tunnel to a managed cluster, end to end.
            Use the full <Link href="/onboarding" className="underline">general wizard</Link> if you also need to set up notifications and observability.
          </p>
        </div>
      </div>

      <ClusterWorkflow
        onComplete={() => router.push("/clusters")}
        allowAnother
      />
    </div>
  );
}
