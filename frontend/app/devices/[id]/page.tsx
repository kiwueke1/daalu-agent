"use client";

/**
 * Device detail + intent editor.
 *
 * The form variant rendered depends on the device's transport. Linux is
 * fully form-based (hostname / authorized_keys / sysctl / packages);
 * Redfish + Network share a JSON editor for now because their field
 * sets are richer and would benefit from per-fact UIs that are themselves
 * follow-ups. The form-based Linux editor is what most operators will
 * touch most often; the JSON fallback keeps the others usable.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  GitPullRequest,
  HardDrive,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  api,
  type SotIntent,
  type SotReconcileResult,
  type SotTransport,
} from "@/lib/api";

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: device, isLoading: devLoading } = useQuery({
    queryKey: ["sot-device", id],
    queryFn: () => api.sot.devices.get(id),
    enabled: !!id,
  });
  const { data: intent, isLoading: intentLoading } = useQuery({
    queryKey: ["sot-intent", id],
    queryFn: () =>
      api.sot.devices.intent(id).catch((e) => {
        if (String(e).includes("404")) return null;
        throw e;
      }),
    enabled: !!id,
  });

  const reconcile = useMutation({
    mutationFn: () => api.sot.devices.reconcile(id),
  });

  if (devLoading) {
    return <div className="p-6 text-sm text-muted">Loading device…</div>;
  }
  if (!device) {
    return (
      <div className="p-6 max-w-2xl">
        <Link
          href="/operations?tab=devices"
          className="text-sm text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to devices
        </Link>
        <div className="mt-4 text-sm text-[color:var(--critical)]">
          Device not found.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] space-y-4">
      <Link
        href="/operations?tab=devices"
        className="text-xs text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1.5"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to devices
      </Link>

      <section className="surface p-5">
        <div className="flex items-start gap-3">
          <div
            className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
          >
            <HardDrive className="h-5 w-5 text-accent-cyan" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">{device.name}</h1>
            <div className="text-[11px] text-muted mt-0.5">
              <span className="font-mono">{device.id}</span>
              <span className="mx-2">·</span>
              <span>{device.transport}</span>
              <span className="mx-2">·</span>
              <span>{device.primary_ip || "no IP"}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
            className="text-xs h-8 px-3 rounded-lg border border-line text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {reconcile.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Reconcile now
          </button>
          <Link
            href={`/operations?tab=proposals&device_id=${device.id}`}
            className="text-xs h-8 px-3 rounded-lg border border-line text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1.5"
          >
            <GitPullRequest className="h-3.5 w-3.5" /> Related proposals
          </Link>
        </div>
        {reconcile.isError && (
          <div className="mt-3 text-xs text-[color:var(--critical)]">
            Reconcile failed: {String(reconcile.error)}
          </div>
        )}
        {reconcile.data && (
          <ReconcileBanner result={reconcile.data} />
        )}
      </section>

      <section className="surface p-5 space-y-3">
        <div>
          <h2 className="text-base font-semibold">Intended config</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Daalu's executor pushes whatever you save here. Drift detection
            re-checks every {`{`}sot_reconcile_period_s{`}`} seconds; if the
            device differs, a ChangeProposal lands in /proposals.
          </p>
        </div>

        {intentLoading ? (
          <div className="text-xs text-muted">Loading intent…</div>
        ) : device.transport === "linux_ssh" ? (
          <LinuxIntentEditor deviceId={id} initial={intent} />
        ) : (
          <JsonIntentEditor
            deviceId={id}
            transport={device.transport}
            initial={intent}
          />
        )}
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Linux — form-based editor for hostname + authorized_keys + sysctl
// ────────────────────────────────────────────────────────────────────────

interface LinuxFactsForm {
  hostname: string;
  authorized_keys: { user: string; key: string }[];
  sysctl: { name: string; value: string }[];
  packages: { name: string; state: "present" | "absent" }[];
}

function emptyLinux(): LinuxFactsForm {
  return { hostname: "", authorized_keys: [], sysctl: [], packages: [] };
}

function fromIntent(intent: SotIntent | null | undefined): LinuxFactsForm {
  const f = (intent?.facts ?? {}) as Record<string, unknown>;
  return {
    hostname: typeof f.hostname === "string" ? f.hostname : "",
    authorized_keys: Array.isArray(f.authorized_keys)
      ? (f.authorized_keys as { user: string; key: string }[])
      : [],
    sysctl: Array.isArray(f.sysctl)
      ? (f.sysctl as { name: string; value: string }[])
      : [],
    packages: Array.isArray(f.packages)
      ? (f.packages as { name: string; state: "present" | "absent" }[])
      : [],
  };
}

function LinuxIntentEditor({
  deviceId,
  initial,
}: {
  deviceId: string;
  initial: SotIntent | null | undefined;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<LinuxFactsForm>(() => fromIntent(initial));

  useEffect(() => {
    setForm(fromIntent(initial));
  }, [initial]);

  const save = useMutation({
    mutationFn: () => {
      // Strip empty rows server-side validation would reject.
      const facts: Record<string, unknown> = {
        hostname: form.hostname || undefined,
        authorized_keys: form.authorized_keys.filter((k) => k.user && k.key),
        sysctl: form.sysctl.filter((s) => s.name && s.value),
        packages: form.packages.filter((p) => p.name),
      };
      return api.sot.devices.updateIntent(deviceId, facts);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sot-intent", deviceId] });
    },
  });

  return (
    <div className="space-y-4">
      <label className="text-xs space-y-1 block">
        <div className="text-muted uppercase tracking-wider">Hostname</div>
        <input
          type="text"
          value={form.hostname}
          onChange={(e) => setForm({ ...form, hostname: e.target.value })}
          placeholder="web01"
          className="w-full h-9 px-3 rounded-lg bg-bg-elevated/60 border border-line text-sm"
        />
      </label>

      <RowList
        label="Authorized SSH keys"
        rows={form.authorized_keys}
        onChange={(rows) => setForm({ ...form, authorized_keys: rows })}
        fields={[
          { key: "user", label: "User", placeholder: "deploy", flex: 1 },
          { key: "key", label: "Public key", placeholder: "ssh-ed25519 AAAA…", flex: 4, mono: true },
        ]}
        addLabel="Add authorized key"
      />

      <RowList
        label="sysctl values"
        rows={form.sysctl}
        onChange={(rows) => setForm({ ...form, sysctl: rows })}
        fields={[
          { key: "name", label: "Key", placeholder: "vm.swappiness", flex: 2, mono: true },
          { key: "value", label: "Value", placeholder: "10", flex: 1, mono: true },
        ]}
        addLabel="Add sysctl"
        help="Renders into /etc/sysctl.d/99-daalu.conf"
      />

      <RowList
        label="Packages"
        rows={form.packages}
        onChange={(rows) =>
          setForm({
            ...form,
            packages: rows as { name: string; state: "present" | "absent" }[],
          })
        }
        fields={[
          { key: "name", label: "Package", placeholder: "curl", flex: 2 },
          {
            key: "state",
            label: "State",
            placeholder: "present",
            flex: 1,
            options: ["present", "absent"],
          },
        ]}
        addLabel="Add package"
        help="apt / dnf install or remove. Adapter ignores the package's own dependency choices — daalu only manages the named packages."
      />

      <div className="flex justify-between items-center pt-3 border-t border-line/40">
        <div className="text-[11px] text-muted">
          {save.isSuccess && (
            <span className="text-[color:var(--accent-emerald)] inline-flex items-center gap-1">
              <Check className="h-3 w-3" /> Saved revision {save.data.revision}
            </span>
          )}
          {save.isError && (
            <span className="text-[color:var(--critical)] inline-flex items-center gap-1">
              <X className="h-3 w-3" /> {String(save.error)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="text-xs h-9 px-4 rounded-lg bg-gradient-to-r from-accent-emerald to-accent-cyan text-bg-base disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <Save className="h-3.5 w-3.5" /> Save intent
        </button>
      </div>
    </div>
  );
}

function RowList<T extends Record<string, string>>({
  label,
  rows,
  onChange,
  fields,
  addLabel,
  help,
}: {
  label: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  fields: {
    key: keyof T & string;
    label: string;
    placeholder?: string;
    flex?: number;
    mono?: boolean;
    options?: string[];
  }[];
  addLabel: string;
  help?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      {help && <div className="text-[10.5px] text-muted">{help}</div>}
      <div className="space-y-1.5">
        {rows.length === 0 && (
          <div className="text-[11.5px] text-muted italic px-1">
            (none managed — add one if daalu should enforce it)
          </div>
        )}
        {rows.map((row, i) => (
          <div key={i} className="flex gap-1.5 items-center">
            {fields.map((f) => (
              <div
                key={f.key}
                className="grow"
                style={{ flex: f.flex ?? 1 }}
              >
                {f.options ? (
                  <select
                    value={row[f.key] || f.options[0]}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...row, [f.key]: e.target.value } as T;
                      onChange(next);
                    }}
                    className="w-full h-8 px-2 rounded-md bg-bg-elevated/60 border border-line text-[12px]"
                  >
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={row[f.key] || ""}
                    onChange={(e) => {
                      const next = [...rows];
                      next[i] = { ...row, [f.key]: e.target.value } as T;
                      onChange(next);
                    }}
                    placeholder={f.placeholder}
                    className={`w-full h-8 px-2 rounded-md bg-bg-elevated/60 border border-line text-[12px] ${f.mono ? "font-mono" : ""}`}
                  />
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="h-8 w-8 rounded-md text-muted hover:text-[color:var(--critical)] hover:bg-bg-elevated/60 inline-flex items-center justify-center"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          const blank = Object.fromEntries(
            fields.map((f) => [f.key, f.options ? f.options[0] : ""]),
          ) as T;
          onChange([...rows, blank]);
        }}
        className="text-[11px] text-muted hover:text-[color:var(--text)] inline-flex items-center gap-1 mt-1"
      >
        + {addLabel}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Non-Linux — JSON editor fallback for Redfish / Junos / IOS-XR / EOS
// ────────────────────────────────────────────────────────────────────────

const TRANSPORT_PLACEHOLDER: Record<SotTransport, string> = {
  linux_ssh: "{}",
  redfish: `{
  "bios_attributes": [
    {"name": "BootMode", "value": "Uefi"}
  ],
  "boot_override": {"target": "None", "enabled": "Disabled"},
  "power": {"desired_state": "On"}
}`,
  junos: `{
  "hostname": "leaf01",
  "interfaces": [
    {"name": "ge-0/0/0", "description": "uplink", "enabled": true, "mtu": 9216}
  ],
  "vlans": [{"vlan_id": 100, "name": "prod-web"}],
  "static_routes": []
}`,
  iosxr: `{
  "hostname": "asr01",
  "interfaces": [
    {"name": "GigabitEthernet0/0/0/1", "enabled": true}
  ],
  "static_routes": []
}`,
  eos: `{
  "hostname": "spine01",
  "interfaces": [
    {"name": "Ethernet1", "enabled": true}
  ],
  "vlans": [{"vlan_id": 100, "name": "prod-web"}]
}`,
  unknown: "{}",
};

function JsonIntentEditor({
  deviceId,
  transport,
  initial,
}: {
  deviceId: string;
  transport: SotTransport;
  initial: SotIntent | null | undefined;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(() =>
    initial?.facts
      ? JSON.stringify(initial.facts, null, 2)
      : TRANSPORT_PLACEHOLDER[transport],
  );
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (initial?.facts) setText(JSON.stringify(initial.facts, null, 2));
  }, [initial]);

  const save = useMutation({
    mutationFn: () => {
      let facts: Record<string, unknown>;
      try {
        facts = JSON.parse(text);
      } catch (e) {
        throw new Error(`Invalid JSON — ${String(e)}`);
      }
      return api.sot.devices.updateIntent(deviceId, facts);
    },
    onSuccess: () => {
      setParseError(null);
      qc.invalidateQueries({ queryKey: ["sot-intent", deviceId] });
    },
    onError: (e) => setParseError(String(e)),
  });

  return (
    <div className="space-y-3">
      <div className="text-[12px] text-muted">
        The form-based editor isn't built for the {transport} schema yet — for
        now, hand-edit the JSON below. The server validates it against the
        right facts schema on save; invalid shapes return a 422 and the
        intent is not written.
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        spellCheck={false}
        className="w-full px-3 py-2 rounded-lg bg-bg-elevated/60 border border-line text-[12px] font-mono"
      />
      <div className="flex justify-between items-center pt-2">
        <div className="text-[11px] text-muted">
          {save.isSuccess && (
            <span className="text-[color:var(--accent-emerald)] inline-flex items-center gap-1">
              <Check className="h-3 w-3" /> Saved revision {save.data.revision}
            </span>
          )}
          {parseError && (
            <span className="text-[color:var(--critical)] inline-flex items-center gap-1">
              <X className="h-3 w-3" /> {parseError}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="text-xs h-9 px-4 rounded-lg bg-gradient-to-r from-accent-emerald to-accent-cyan text-bg-base disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <Save className="h-3.5 w-3.5" /> Save intent
        </button>
      </div>
    </div>
  );
}

function ReconcileBanner({ result }: { result: SotReconcileResult }) {
  const accent =
    result.status === "in_sync"
      ? "var(--accent-emerald, #10b981)"
      : result.status === "drift"
        ? "var(--warning, #f59e0b)"
        : result.status === "error"
          ? "var(--critical)"
          : "var(--muted, #94a3b8)";
  const Icon =
    result.status === "in_sync"
      ? CheckCircle2
      : result.status === "drift"
        ? GitPullRequest
        : RefreshCw;
  return (
    <div
      className="mt-3 px-3 py-2 rounded-lg border text-xs flex items-center gap-2"
      style={{
        borderColor: `color-mix(in srgb, ${accent} 38%, transparent)`,
        background: `color-mix(in srgb, ${accent} 10%, transparent)`,
        color: accent,
      }}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="font-semibold uppercase tracking-wider text-[10px]">
        {result.status}
      </span>
      <span className="text-[color:var(--text)]/80">
        {result.detail ?? "reconcile complete"}
      </span>
      {result.proposal_id && (
        <Link
          href={`/proposals/${result.proposal_id}`}
          className="ml-auto underline hover:text-[color:var(--text)]"
        >
          open proposal
        </Link>
      )}
    </div>
  );
}
