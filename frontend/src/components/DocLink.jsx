import { useState } from "react";
import { fmtTime, short } from "../lib/contracts";
import { fetchLedgerDoc, parseLink } from "../lib/docs";
import { Addr, Badge, Button, Notice } from "../lib/ui";

/**
 * Renders a document link the way it deserves:
 *  - ledger://  → "Open" fetches the bytes from the chain, recomputes the fingerprint and
 *                 shows whether it matches the one recorded next to it
 *  - ipfs://    → opens through a public gateway
 *  - https://   → plain link
 */
export default function DocLink({ uri, expectedHash, contracts }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const link = parseLink(uri);

  if (link.kind === "none") return <span className="mono">—</span>;
  if (link.kind === "ipfs") {
    return (
      <span>
        <a href={link.url} target="_blank" rel="noreferrer"><code>{uri}</code></a>{" "}
        <span style={{ color: "var(--muted)", fontSize: 12 }}>(opens via ipfs.io)</span>
      </span>
    );
  }
  if (link.kind === "http") {
    return <a href={link.url} target="_blank" rel="noreferrer"><code>{uri}</code></a>;
  }
  if (link.kind === "other") return <code>{uri}</code>;

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (doc || err) return;
    setBusy(true);
    try {
      const d = await fetchLedgerDoc(contracts, link.hash);
      if (!d) setErr("Nothing is stored on the ledger under this fingerprint.");
      else setDoc(d);
    } catch (e) {
      setErr(e?.shortMessage || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const matches = doc && expectedHash ? doc.computed.toLowerCase() === expectedHash.toLowerCase() : null;

  return (
    <span style={{ display: "inline-block", width: "100%" }}>
      <code title={uri}>ledger://{short(link.hash)}</code>{" "}
      <Badge tone="accent">on the ledger</Badge>{" "}
      <Button size="sm" variant="ghost" busy={busy} onClick={toggle}>{open ? "Close" : "Open & verify"}</Button>
      {open && (
        <div className="doc-viewer">
          {err && <Notice tone="warn">{err}</Notice>}
          {doc && (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                {matches === null ? (
                  <Badge tone="muted">fingerprint {short(doc.computed)}</Badge>
                ) : matches ? (
                  <Badge tone="ok">✔ matches the fingerprint on record</Badge>
                ) : (
                  <Badge tone="err">✘ does NOT match the fingerprint on record</Badge>
                )}
                <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
                  stored by <Addr value={doc.storedBy} /> · {fmtTime(doc.storedAt)} · {doc.size} bytes
                </span>
              </div>
              <pre>{doc.text ?? doc.bytes}</pre>
            </>
          )}
        </div>
      )}
    </span>
  );
}
