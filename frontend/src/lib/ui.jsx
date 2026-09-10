import { useCallback, useState } from "react";
import { explainError, short } from "./contracts";

export function Card({ title, subtitle, right, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
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

export function Badge({ tone = "muted", children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Notice({ tone = "info", children }) {
  if (!children) return null;
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Addr({ value, full }) {
  if (!value) return <span className="mono">—</span>;
  const copy = () => navigator.clipboard?.writeText(value).catch(() => {});
  return (
    <span className="addr" title={`${value} (click to copy)`} onClick={copy}>
      {full ? value : short(value)}
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

/**
 * Runs a transaction (or any async action) and tracks its status for the UI.
 * `fn` may return a tx response (awaited to a receipt) or a plain value.
 */
export function useTx(onDone) {
  const [state, setState] = useState({ busy: false, msg: null, tone: "info" });

  const run = useCallback(
    async (label, fn) => {
      setState({ busy: true, msg: `${label}…`, tone: "info" });
      try {
        const result = await fn();
        const receipt = result && typeof result.wait === "function" ? await result.wait() : null;
        setState({
          busy: false,
          msg: receipt ? `${label} ✓  (block ${receipt.blockNumber}, tx ${short(receipt.hash)})` : `${label} ✓`,
          tone: "ok",
        });
        onDone?.(result);
        return result;
      } catch (e) {
        setState({ busy: false, msg: explainError(e), tone: "err" });
        return undefined;
      }
    },
    [onDone]
  );

  return { ...state, run };
}
