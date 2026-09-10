import { useCallback, useState } from "react";
import { describeError, ROLE_INFO, short } from "./contracts";
import { useNames } from "./names";

export function Card({ title, subtitle, right, children, className = "", tone }) {
  return (
    <section className={`card ${tone ? `card-${tone}` : ""} ${className}`}>
      {(title || right) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Input({ mono, className = "", ...rest }) {
  return <input className={`input ${mono ? "mono" : ""} ${className}`} {...rest} />;
}

export function Select({ children, ...rest }) {
  return (
    <select className="input" {...rest}>
      {children}
    </select>
  );
}

export function Button({ variant = "primary", size, busy, children, ...rest }) {
  return (
    <button
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""}`}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function Badge({ tone = "muted", children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function RoleChip({ role }) {
  const info = ROLE_INFO[role];
  return (
    <Badge tone="accent" title={info?.desc}>
      {info?.label ?? short(role)}
    </Badge>
  );
}

/** A status message. `detail` is shown small and muted underneath (used for technical error codes). */
export function Notice({ tone = "info", children, detail }) {
  if (!children) return null;
  return (
    <div className={`notice notice-${tone}`}>
      <div>{children}</div>
      {detail && <div className="notice-detail">{detail}</div>}
    </div>
  );
}

/** Collapsible "What is this?" explainer. */
export function Explain({ title = "What is this?", children }) {
  return (
    <details className="explain">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

/**
 * An address, shown as the person's name and Staff ID whenever the Onboarding
 * contract knows them, otherwise shortened. Hover for the raw address; click to copy.
 */
export function Addr({ value, full }) {
  const { resolve } = useNames();
  if (!value) return <span className="mono">—</span>;
  const label = resolve(value);
  const copy = () => navigator.clipboard?.writeText(value).catch(() => {});
  return (
    <span className="addr" title={`${value} (click to copy)`} onClick={copy}>
      {label ? <span className="person">{label}</span> : null}
      {label && full ? " " : null}
      {full ? <span className="mono">{value}</span> : label ? null : short(value)}
    </span>
  );
}

export function KV({ rows }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, rows, empty = "Nothing here yet." }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/**
 * Runs a transaction (or any async action) and tracks its status for the UI.
 * Successes read "<label> — done"; failures are translated into plain English
 * with the exact contract error kept as a detail line.
 */
export function useTx(onDone) {
  const [state, setState] = useState({ busy: false, msg: null, detail: null, tone: "info" });

  const run = useCallback(
    async (label, fn) => {
      setState({ busy: true, msg: `${label}…`, detail: null, tone: "info" });
      try {
        const result = await fn();
        const receipt = result && typeof result.wait === "function" ? await result.wait() : null;
        setState({
          busy: false,
          msg: `${label} — done.`,
          detail: receipt ? `Recorded in block ${receipt.blockNumber} · transaction ${short(receipt.hash)}` : null,
          tone: "ok",
        });
        onDone?.(result);
        return result;
      } catch (e) {
        const { friendly, technical } = describeError(e);
        setState({ busy: false, msg: friendly, detail: technical, tone: "err" });
        return undefined;
      }
    },
    [onDone]
  );

  return { ...state, run };
}
