import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { describeError, fmtTime, hashText, isZero, LEVELS } from "../lib/contracts";
import { Addr, Badge, Button, Card, Empty, Explain, Field, Input, KV, Notice, Table, useTx } from "../lib/ui";

async function loadAsset(contracts, tokenId) {
  const [owner, asset, uri, provenance, ownerDID, grants] = await Promise.all([
    contracts.nft.ownerOf(tokenId),
    contracts.nft.getAsset(tokenId),
    contracts.nft.tokenURI(tokenId),
    contracts.nft.provenanceOf(tokenId),
    contracts.nft.ownerDID(tokenId),
    contracts.policy.activeGranteesOf(tokenId),
  ]);
  return { tokenId, owner, asset, uri, provenance, ownerDID, grants };
}

function HistoryTable({ provenance }) {
  return (
    <Table
      head={["#", "From", "To", "Done by", "When", "Block"]}
      rows={provenance.map((p, i) => [
        i + 1,
        isZero(p.from) ? <Badge tone="ok">registered</Badge> : <Addr value={p.from} />,
        isZero(p.to) ? <Badge tone="err">retired</Badge> : <Addr value={p.to} />,
        <Addr value={p.operator} />,
        fmtTime(p.timestamp),
        String(p.blockNumber),
      ])}
    />
  );
}

function AssetCard({ a, web3, me, refresh }) {
  const { contracts, account } = web3;
  const [to, setTo] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const tx = useTx(refresh);
  const isOwner = account && a.owner.toLowerCase() === account.toLowerCase();

  return (
    <div className="asset">
      <div className="asset-head">
        <div>
          <strong>Asset #{String(a.tokenId)}</strong> <Badge tone="accent">{a.asset.category || "uncategorised"}</Badge>{" "}
          {a.asset.frozen && <Badge tone="err">frozen by admin</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? "Hide" : "Show"} ownership history ({a.provenance.length})
        </Button>
      </div>
      <KV
        rows={[
          ["Owner", <><Addr value={a.owner} /> <code style={{ color: "var(--muted)" }}>{a.ownerDID}</code></>],
          ["Registered by", <Addr value={a.asset.issuer} />],
          ["Registered on", fmtTime(a.asset.createdAt)],
          ["File link", <code>{a.uri}</code>],
          ["Fingerprint", <code>{a.asset.contentHash}</code>],
          ["Shared with", a.grants[0].length
            ? a.grants[0].map((g, i) => <span key={g}><Addr value={g} /> <Badge>{LEVELS[Number(a.grants[1][i])]}</Badge> </span>)
            : <span className="empty">nobody</span>],
        ]}
      />
      {showHistory && <div style={{ marginTop: 12 }}><HistoryTable provenance={a.provenance} /></div>}

      {(isOwner || me?.isAdmin) && (
        <div className="actions">
          {isOwner && (
            <>
              <Input mono placeholder="send to 0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} style={{ maxWidth: 360 }} />
              <Button size="sm" busy={tx.busy} disabled={!isAddress(to)}
                onClick={() => tx.run(`Send asset #${a.tokenId}`, () => contracts.nft.transferFrom(account, to, a.tokenId))}>
                Send
              </Button>
            </>
          )}
          {me?.isAdmin && (
            <Button size="sm" variant="ghost" busy={tx.busy}
              onClick={() => tx.run(a.asset.frozen ? "Unfreeze asset" : "Freeze asset", () => contracts.nft.setFrozen(a.tokenId, !a.asset.frozen))}>
              {a.asset.frozen ? "Unfreeze" : "Freeze"}
            </Button>
          )}
          <Button size="sm" variant="danger" busy={tx.busy}
            onClick={() => window.confirm(`Retire asset #${a.tokenId}? This permanently removes it. Its history is kept.`) && tx.run("Retire asset", () => contracts.nft.retire(a.tokenId))}>
            Retire
          </Button>
        </div>
      )}
      <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
    </div>
  );
}

export default function AssetsPanel({ web3, me, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [mine, setMine] = useState([]);
  const [total, setTotal] = useState(0n);
  const [mint, setMint] = useState({ to: "", uri: "ipfs://", content: "", category: "contract" });
  const [lookupId, setLookupId] = useState("");
  const [lookup, setLookup] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts) return;
    contracts.nft.totalSupply().then(setTotal).catch(() => {});
    if (!account) { setMine([]); return; }
    (async () => {
      const ids = await contracts.nft.assetsOf(account);
      setMine(await Promise.all(ids.map((id) => loadAsset(contracts, id))));
    })().catch(() => setMine([]));
  }, [contracts, account, refreshKey]);

  const doLookup = async () => {
    setLookupErr(null);
    try {
      setLookup(await loadAsset(contracts, BigInt(lookupId)));
    } catch (e) {
      setLookup(null);
      setLookupErr(describeError(e).friendly);
    }
  };

  const m = (k) => (e) => setMint({ ...mint, [k]: e.target.value });

  return (
    <div className="grid">
      <Card
        title="Register a new asset"
        subtitle="Turn a contract, design, licence or record into a unique token owned by one specific person."
        right={me?.isIssuer ? <Badge tone="ok">you are an Issuer</Badge> : <Badge tone="warn">Issuers only</Badge>}
      >
        <Explain>
          The file itself stays wherever you keep it. What goes on the chain is a <b>fingerprint</b> of its content, a
          link to it, and who owns it. The fingerprint means the same file can't be registered twice, and anyone can
          later prove a file is the one that was registered.
        </Explain>
        <Field label="Owner" hint="Must have an active Digital ID and the User role — the system checks both.">
          <Input mono placeholder="0x…" value={mint.to} onChange={m("to")} />
        </Field>
        <div className="row">
          <Field label="Link to the file"><Input value={mint.uri} onChange={m("uri")} /></Field>
          <Field label="Type" hint="contract, design, report, licence…"><Input value={mint.category} onChange={m("category")} /></Field>
        </div>
        <Field label="File content" hint={mint.content ? `Fingerprint: ${hashText(mint.content)}` : "Paste the text, or a content ID. Only its fingerprint is recorded."}>
          <Input value={mint.content} onChange={m("content")} placeholder="e.g. Supplier Contract 2026 — Acme Ltd" />
        </Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!isAddress(mint.to) || !mint.content}
            onClick={() => tx.run("Register asset", () => contracts.nft.mint(mint.to, mint.uri, hashText(mint.content), mint.category))}>
            Register asset
          </Button>
        </div>
        <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
      </Card>

      <Card title="Find an asset" subtitle={`${total} asset${total === 1n ? "" : "s"} currently registered.`}>
        <div className="row">
          <Input type="number" min="1" placeholder="asset #" value={lookupId} onChange={(e) => setLookupId(e.target.value)} style={{ maxWidth: 160 }} />
          <Button variant="ghost" disabled={!lookupId} onClick={doLookup}>Find</Button>
        </div>
        {lookupErr && <Notice tone="err">{lookupErr}</Notice>}
        {lookup && <div style={{ marginTop: 14 }}><AssetCard a={lookup} web3={web3} me={me} refresh={refresh} /></div>}
      </Card>

      <Card className="span-2" title="My assets" subtitle="Everything the selected person currently owns.">
        {!account && <Empty>Pick a person first.</Empty>}
        {account && !mine.length && <Empty>This person doesn't own any assets yet. An Issuer can register one for them.</Empty>}
        {mine.map((a) => <AssetCard key={String(a.tokenId)} a={a} web3={web3} me={me} refresh={refresh} />)}
      </Card>
    </div>
  );
}
