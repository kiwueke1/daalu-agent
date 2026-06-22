"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Loader2,
  Upload,
} from "lucide-react";
import { api, type SotBulkImportResult, type SotBulkRow } from "@/lib/api";

const YAML_EXAMPLE = `devices:
  - name: web01
    primary_ip: 10.0.0.5/24
    transport: linux_ssh
    site: dc1
    device_type: generic-server
    role: server
    platform: linux

  - name: edge-router-3
    primary_ip: 10.10.0.1/24
    transport: junos
    site: dc1
    device_type: mx204
    role: edge-router
`;

const EXCEL_COLUMNS =
  "name | primary_ip | transport | site | device_type | role | platform (optional)";

export function BulkImportView() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SotBulkImportResult | null>(null);
  const [applied, setApplied] = useState<SotBulkImportResult | null>(null);

  const dryRun = useMutation({
    mutationFn: (f: File) => api.sot.devices.bulkImport(f, true),
    onSuccess: (r) => {
      setPreview(r);
      setApplied(null);
    },
    onError: () => {
      setPreview(null);
    },
  });

  const apply = useMutation({
    mutationFn: (f: File) => api.sot.devices.bulkImport(f, false),
    onSuccess: (r) => {
      setApplied(r);
      qc.invalidateQueries({ queryKey: ["sot-devices"] });
    },
  });

  const reset = () => {
    setFile(null);
    setPreview(null);
    setApplied(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(null);
    setApplied(null);
    dryRun.mutate(f);
  };

  const display = applied ?? preview;
  const hasUploadableRows =
    display !== null &&
    display.summary.valid > 0 &&
    display.summary.errors < display.summary.total;

  return (
    <div className="space-y-5">
      <p className="text-muted text-sm">
        Upload your inventory as a YAML or Excel file. We&apos;ll validate it
        against your Nautobot catalog (sites, device types, roles, platforms)
        and show you a row-by-row preview before anything is created.
      </p>

      {/* Upload box */}
      <div className="surface p-5 space-y-4">
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.xlsx"
            onChange={onPick}
            className="text-xs file:mr-3 file:rounded-lg file:border file:border-line file:bg-bg-elevated/60 file:px-3 file:py-2 file:text-[color:var(--text)] file:cursor-pointer"
          />
          {file && (
            <span className="text-xs text-muted truncate">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </span>
          )}
          {(dryRun.isPending || apply.isPending) && (
            <Loader2 className="h-4 w-4 animate-spin text-muted" />
          )}
          {file && (
            <button
              type="button"
              onClick={reset}
              className="ml-auto text-[11px] text-muted hover:text-[color:var(--text)] underline"
            >
              Reset
            </button>
          )}
        </div>

        {dryRun.isError && (
          <div className="text-xs text-[color:var(--critical)]">
            {String(dryRun.error)}
          </div>
        )}
      </div>

      {/* Preview table */}
      {display && (
        <div className="surface p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-semibold">
                {applied ? "Applied" : "Preview"}
              </span>
              <span className="text-muted">
                {display.summary.total} rows ·{" "}
                <span className="text-[color:var(--text)]">
                  {display.summary.valid}
                </span>{" "}
                valid
                {display.summary.errors > 0 && (
                  <>
                    {" · "}
                    <span className="text-[color:var(--critical)]">
                      {display.summary.errors}
                    </span>{" "}
                    error{display.summary.errors === 1 ? "" : "s"}
                  </>
                )}
                {applied && display.summary.created > 0 && (
                  <>
                    {" · "}
                    <span className="text-accent-emerald">
                      {display.summary.created}
                    </span>{" "}
                    created
                  </>
                )}
              </span>
            </div>
            {!applied && (
              <button
                type="button"
                disabled={!hasUploadableRows || apply.isPending || !file}
                onClick={() => file && apply.mutate(file)}
                className="text-xs h-9 px-4 rounded-lg bg-gradient-to-r from-accent-emerald to-accent-cyan text-bg-base disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {apply.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying…
                  </>
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5" /> Apply{" "}
                    {display.summary.valid} device
                    {display.summary.valid === 1 ? "" : "s"}
                  </>
                )}
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted border-b border-line">
                  <th className="text-left px-3 py-2 w-12">Row</th>
                  <th className="text-left px-3 py-2 w-12">Status</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Primary IP</th>
                  <th className="text-left px-3 py-2">Transport</th>
                  <th className="text-left px-3 py-2">Site</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Role</th>
                  <th className="text-left px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {display.rows.map((r) => (
                  <RowCell key={r.row} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {apply.isError && (
        <div className="text-xs text-[color:var(--critical)]">
          Apply failed: {String(apply.error)}
        </div>
      )}

      {/* Format reference */}
      <details className="surface p-4">
        <summary className="cursor-pointer text-sm font-medium inline-flex items-center gap-2">
          <FileText className="h-4 w-4 text-accent-cyan" /> YAML format
        </summary>
        <pre className="mt-3 text-[11.5px] font-mono whitespace-pre bg-bg-elevated/60 border border-line rounded-lg p-3 overflow-x-auto">
          {YAML_EXAMPLE}
        </pre>
        <p className="text-[11px] text-muted mt-2">
          A bare top-level list (no <code>devices:</code> key) also works.
          Names in <code>site</code>, <code>device_type</code>,{" "}
          <code>role</code>, <code>platform</code> are resolved
          case-insensitively against your Nautobot catalog — they don&apos;t
          have to be the UUIDs.
        </p>
      </details>

      <details className="surface p-4">
        <summary className="cursor-pointer text-sm font-medium inline-flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-accent-cyan" /> Excel format
        </summary>
        <p className="text-xs text-muted mt-2 leading-relaxed">
          First sheet, first row = headers (case-insensitive). Columns:{" "}
          <code>{EXCEL_COLUMNS}</code>. Empty rows are skipped. Transports must
          be one of <code>linux_ssh</code>, <code>redfish</code>,{" "}
          <code>junos</code>, <code>iosxr</code>, <code>eos</code>.
        </p>
      </details>
    </div>
  );
}

function RowCell({ row }: { row: SotBulkRow }) {
  const accent =
    row.status === "error"
      ? "var(--critical)"
      : row.status === "created"
        ? "var(--accent-emerald, #10b981)"
        : "var(--muted, #94a3b8)";
  const Icon =
    row.status === "error"
      ? AlertCircle
      : row.status === "created"
        ? CheckCircle2
        : FileText;
  return (
    <tr className="border-b border-line/40 last:border-b-0 align-top">
      <td className="px-3 py-2 text-muted font-mono">{row.row}</td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1" style={{ color: accent }}>
          <Icon className="h-3 w-3" />
          <span className="uppercase text-[10px] tracking-wider">{row.status}</span>
        </span>
      </td>
      <td className="px-3 py-2 font-medium">{row.name || "—"}</td>
      <td className="px-3 py-2 font-mono text-[11px]">{row.primary_ip || "—"}</td>
      <td className="px-3 py-2">{row.transport || "—"}</td>
      <td className="px-3 py-2">{row.site || "—"}</td>
      <td className="px-3 py-2">{row.device_type || "—"}</td>
      <td className="px-3 py-2">{row.role || "—"}</td>
      <td className="px-3 py-2 text-muted">
        {row.error ? (
          <span style={{ color: accent }}>{row.error}</span>
        ) : row.device_id ? (
          <span className="font-mono text-[10px]">{row.device_id.slice(0, 8)}</span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
