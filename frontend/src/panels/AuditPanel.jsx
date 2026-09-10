import { useEffect, useMemo, useState } from "react";
import { isAddress } from "ethers";
import { ACTION_LABEL, fmtTime, short } from "../lib/contracts";
import { Addr, Badge, Button, Card, Input, Notice, Table } from "../lib/ui";

const PAGE = 50;

const TONE = (action) => {
  const name = ACTION_LABEL[action] ?? "";
  if (name.includes("REVOKED") || name.includes("DEACTIVATED") || name.includes("FROZEN") || name.includes("RETIRED")) return "err";
  if (name.includes("GRANTED") || name.includes("REGISTERED") || name.includes("MINTED") || name.includes("ANCHORED") || name.includes("REACTIVATED") || name.includes("UNFROZEN")) return "ok";
  return "muted";
};

export default function AuditPanel({ web3, refreshKey }) {
  const { contracts, deployment } = web3;
  const [total, setTotal] = useState(0n);
  const [head, setHead] = useState(null);
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [chain, setChain] = useState(null);
  const [busy, setBusy] = useState(false);

  const contractName = useMemo(() => {
    const map = {};
    for (const [name, addr] of Object.entries(deployment?.contracts ?? {})) map[addr.toLowerCase()] = name;
    return (addr) => map[addr?.toLowerCase()] ?? short(addr);
  }, [deployment]);

  useEffect(() => {
    if (!contracts) return;
    setBusy(true);
    (async () => {
      const [t, h] = await Promise.all([contracts.audit.totalEntries(), contracts.audit.head()]);
      setTotal(t);
      setHead(h);

      let rows;
      if (applied && isAddress(applied)) {
        const [asActor, asSubject] = await Promise.all([
          contracts.audit.entriesByActor(applied),
          contracts.audit.entriesBySubject(applied),
        ]);
        const ids = [...new Set([...asActor, ...asSubject].map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
        // ethers Result objects spread by index, not by name — toObject() gives the named struct fields
        rows = await Promise.all(ids.map(async (id) => ({ id, ...(await contracts.audit.entryAt(id)).toObject() })));
      } else {
        const from = t > BigInt(PAGE) ? t - BigInt(PAGE) : 0n;
        const page = await contracts.audit.getRange(from, PAGE);
        rows = page.map((e, i) => ({ id: from + BigInt(i), ...e.toObject() }));
      }
      setEntries(rows.reverse());
    })().catch(() => setEntries([])).finally(() => setBusy(false));
  }, [contracts, applied, refreshKey]);

  const verify = async () => {
    if (total === 0n) return setChain({ ok: true, brokenAt: 0n, empty: true });
    const [ok, brokenAt] = await contracts.audit.verifyChain(0, total - 1n);
    setChain({ ok, brokenAt });
  };

  return (
    <div>
      <Card title="Audit trail" subtitle="Append-only and hash-chained. Every entry commits to the hash of the one before it, so nothing can be altered or removed without breaking the chain.">
        <div className="stats">
          <div className="stat"><b>{String(total)}</b><span>entries</span></div>
          <div className="stat"><b className="mono" style={{ fontSize: 14 }}>{head ? `${head.slice(0, 14)}…${head.slice(-6)}` : "—"}</b><span>chain head</span></div>
          <div className="stat">
            <Button variant="ghost" onClick={verify}>Verify whole chain</Button>
            {chain && (
              <span style={{ marginTop: 6 }}>
                {chain.ok ? <Badge tone="ok">intact ✓ {chain.empty ? "(empty)" : `0 → ${String(total - 1n)}`}</Badge> : <Badge tone="err">BROKEN at #{String(chain.brokenAt)}</Badge>}
              </span>
            )}
          </div>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <Input mono placeholder="filter by address (as actor or subject)" value={filter} onChange={(e) => setFilter(e.target.value.trim())} style={{ maxWidth: 420 }} />
          <Button variant="ghost" disabled={filter && !isAddress(filter)} onClick={() => setApplied(filter)}>Apply</Button>
          {applied && <Button variant="ghost" onClick={() => { setFilter(""); setApplied(""); }}>Clear</Button>}
        </div>
        {applied && <Notice tone="info">Showing every entry where <Addr value={applied} /> is the actor or the subject.</Notice>}
        {!applied && total > BigInt(PAGE) && <Notice tone="info">Showing the latest {PAGE} of {String(total)} entries. Filter by address to see older history.</Notice>}

        <div style={{ marginTop: 10 }}>
          <Table
            head={["#", "When", "Action", "Actor", "Subject", "Ref", "Source", "Entry hash"]}
            empty={busy ? "Loading…" : "No entries."}
            rows={entries.map((e) => [
              String(e.id),
              fmtTime(e.timestamp),
              <Badge tone={TONE(e.action)}>{ACTION_LABEL[e.action] ?? short(e.action)}</Badge>,
              <Addr value={e.actor} />,
              <Addr value={e.subject} />,
              e.refId > 0n ? (e.refId < 1000000n ? `#${String(e.refId)}` : short("0x" + e.refId.toString(16).padStart(64, "0"))) : "",
              <span style={{ color: "var(--muted)" }}>{contractName(e.source)}</span>,
              <code title={e.entryHash}>{short(e.entryHash)}</code>,
            ])}
          />
        </div>
      </Card>
    </div>
  );
}
