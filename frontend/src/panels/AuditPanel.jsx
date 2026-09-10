import { useEffect, useMemo, useState } from "react";
import { isAddress } from "ethers";
import { ACTION_CODE, ACTION_LABEL, fmtTime, short } from "../lib/contracts";
import { Addr, Badge, Button, Card, Explain, Input, Notice, Table } from "../lib/ui";

const PAGE = 50;

const TONE = (action) => {
  const code = ACTION_CODE[action] ?? "";
  if (/REVOKED|DEACTIVATED|FROZEN$|RETIRED/.test(code)) return "err";
  if (/GRANTED|REGISTERED|MINTED|ANCHORED|REACTIVATED|UNFROZEN/.test(code)) return "ok";
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
    if (total === 0n) return setChain({ ok: true, empty: true });
    const [ok, brokenAt] = await contracts.audit.verifyChain(0, total - 1n);
    setChain({ ok, brokenAt });
  };

  const ref = (e) => {
    if (e.refId === 0n) return "";
    if (e.refId < 1000000n) return `asset #${String(e.refId)}`;
    return <span title="reference id">{short("0x" + e.refId.toString(16).padStart(64, "0"))}</span>;
  };

  return (
    <div className="stack">
      <Card
        title="History"
        subtitle="Every action in this system is written here, in order. Each entry is chained to the one before it, so nothing can be changed or deleted — not even by an admin."
      >
        <Explain title="Why can this be trusted?">
          Each entry includes a fingerprint of the previous entry. Change or remove any entry and every fingerprint after
          it stops matching — <b>Verify the whole log</b> recomputes them all and reports the first mismatch. Only the
          system's own contracts can write here; no person can, and there is no edit or delete function at all.
          Actions that were <i>refused</i> never appear, because they never happened.
        </Explain>

        <div className="stats">
          <div className="stat"><b>{String(total)}</b><span>entries</span></div>
          <div className="stat"><b className="mono" style={{ fontSize: 14 }}>{head ? `${head.slice(0, 14)}…${head.slice(-6)}` : "—"}</b><span>fingerprint of the latest entry</span></div>
          <div className="stat">
            <Button variant="ghost" onClick={verify}>Verify the whole log</Button>
            {chain && (
              <span style={{ marginTop: 6 }}>
                {chain.ok
                  ? <Badge tone="ok">{chain.empty ? "log is empty" : `all ${String(total)} entries verified — nothing has been tampered with`}</Badge>
                  : <Badge tone="err">TAMPERED — first bad entry is #{String(chain.brokenAt)}</Badge>}
              </span>
            )}
          </div>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <Input mono placeholder="show only actions by, or about, this address" value={filter} onChange={(e) => setFilter(e.target.value.trim())} style={{ maxWidth: 440 }} />
          <Button variant="ghost" disabled={filter && !isAddress(filter)} onClick={() => setApplied(filter)}>Filter</Button>
          {applied && <Button variant="ghost" onClick={() => { setFilter(""); setApplied(""); }}>Show all</Button>}
        </div>
        {applied && <Notice tone="info">Showing everything <Addr value={applied} /> did, or that was done to them.</Notice>}
        {!applied && total > BigInt(PAGE) && <Notice tone="info">Showing the latest {PAGE} of {String(total)} entries. Filter by address to see older history.</Notice>}

        <div style={{ marginTop: 12 }}>
          <Table
            head={["#", "When", "What happened", "Who did it", "About", "Reference", "Recorded by", "Fingerprint"]}
            empty={busy ? "Loading…" : "No entries."}
            rows={entries.map((e) => [
              String(e.id),
              fmtTime(e.timestamp),
              <Badge tone={TONE(e.action)} title={ACTION_CODE[e.action]}>{ACTION_LABEL[e.action] ?? short(e.action)}</Badge>,
              <Addr value={e.actor} />,
              e.subject.toLowerCase() === e.actor.toLowerCase() ? <span style={{ color: "var(--muted)" }}>themselves</span> : <Addr value={e.subject} />,
              ref(e),
              <span style={{ color: "var(--muted)" }}>{contractName(e.source)}</span>,
              <code title={e.entryHash}>{short(e.entryHash)}</code>,
            ])}
          />
        </div>
      </Card>
    </div>
  );
}
