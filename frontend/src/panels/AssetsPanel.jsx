import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { fmtTime, hashText, LEVELS } from "../lib/contracts";
import { Addr, Badge, Button, Card, Field, Input, KV, Notice, Table, useTx } from "../lib/ui";

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

function ProvenanceTable({ provenance }) {
  return (
    <Table
      head={["#", "From", "To", "By", "When", "Block"]}
      rows={provenance.map((p, i) => [
        i + 1,
        p.from === "0x0000000000000000000000000000000000000000" ? <Badge tone="ok">minted</Badge> : <Addr value={p.from} />,
        p.to === "0x0000000000000000000000000000000000000000" ? <Badge tone="err">retired</Badge> : <Addr value={p.to} />,
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
  const [showProv, setShowProv] = useState(false);
  const tx = useTx(refresh);
  const isOwner = account && a.owner.toLowerCase() === account.toLowerCase();

  return (
    <div className="asset">
      <div className="asset-head">
        <div>
          <strong>Asset #{String(a.tokenId)}</strong> <Badge tone="accent">{a.asset.category || "uncategorised"}</Badge>{" "}
          {a.asset.frozen && <Badge tone="err">frozen</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowProv(!showProv)}>
          {showProv ? "hide" : "show"} provenance ({a.provenance.length})
        </Button>
      </div>
      <KV
        rows={[
          ["Owner", <><Addr value={a.owner} /> <code style={{ color: "var(--muted)" }}>{a.ownerDID}</code></>],
          ["Issuer", <Addr value={a.asset.issuer} />],
          ["Created", fmtTime(a.asset.createdAt)],
          ["URI", <code>{a.uri}</code>],
          ["Content hash", <code>{a.asset.contentHash}</code>],
          ["Access grants", a.grants[0].length
            ? a.grants[0].map((g, i) => <span key={g}><Addr value={g} /> <Badge>{LEVELS[Number(a.grants[1][i])]}</Badge> </span>)
            : <span className="empty">none active</span>],
        ]}
      />
      {showProv && <div style={{ marginTop: 10 }}><ProvenanceTable provenance={a.provenance} /></div>}

      {(isOwner || me?.isAdmin) && (
        <div className="actions">
          {isOwner && (
            <>
              <Input mono placeholder="transfer to 0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} style={{ maxWidth: 360 }} />
              <Button size="sm" busy={tx.busy} disabled={!isAddress(to)}
                onClick={() => tx.run(`Transfer #${a.tokenId}`, () => contracts.nft.transferFrom(account, to, a.tokenId))}>
                Transfer
              </Button>
            </>
          )}
          {me?.isAdmin && (
            <Button size="sm" variant="ghost" busy={tx.busy}
              onClick={() => tx.run(a.asset.frozen ? "Unfreeze" : "Freeze", () => contracts.nft.setFrozen(a.tokenId, !a.asset.frozen))}>
              {a.asset.frozen ? "Unfreeze" : "Freeze"}
            </Button>
          )}
          <Button size="sm" variant="danger" busy={tx.busy}
            onClick={() => window.confirm(`Retire asset #${a.tokenId}? This burns the token.`) && tx.run("Retire", () => contracts.nft.retire(a.tokenId))}>
            Retire
          </Button>
        </div>
      )}
      <Notice tone={tx.tone}>{tx.msg}</Notice>
    </div>
  );
}

export default function AssetsPanel({ web3, me, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [mine, setMine] = useState([]);
  const [total, setTotal] = useState(0n);
  const [mint, setMint] = useState({ to: "", uri: "ipfs://", content: "", category: "document" });
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
      setLookupErr("No such asset (or it has been retired).");
    }
  };

  const m = (k) => (e) => setMint({ ...mint, [k]: e.target.value });

  return (
    <div className="grid">
      <Card
        title="Mint an asset"
        subtitle="Creates an ERC-721 whose holder must have an active DID and USER_ROLE."
        right={me?.isIssuer ? <Badge tone="ok">you are an ISSUER</Badge> : <Badge tone="warn">requires ISSUER_ROLE</Badge>}
      >
        <Field label="Owner address"><Input mono placeholder="0x…" value={mint.to} onChange={m("to")} /></Field>
        <div className="row">
          <Field label="Metadata URI"><Input value={mint.uri} onChange={m("uri")} /></Field>
          <Field label="Category"><Input value={mint.category} onChange={m("category")} /></Field>
        </div>
        <Field label="Content (hashed client-side)" hint={mint.content ? `keccak256: ${hashText(mint.content)}` : "Identifies the underlying file; the same content can only be minted once."}>
          <Input value={mint.content} onChange={m("content")} placeholder="paste the document text, or its CID" />
        </Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!isAddress(mint.to) || !mint.content}
            onClick={() => tx.run("Mint asset", () => contracts.nft.mint(mint.to, mint.uri, hashText(mint.content), mint.category))}>
            Mint
          </Button>
        </div>
        <Notice tone={tx.tone}>{tx.msg}</Notice>
      </Card>

      <Card title="Look up an asset" subtitle={`${total} asset${total === 1n ? "" : "s"} currently in circulation.`}>
        <div className="row">
          <Input type="number" min="1" placeholder="token id" value={lookupId} onChange={(e) => setLookupId(e.target.value)} style={{ maxWidth: 160 }} />
          <Button variant="ghost" disabled={!lookupId} onClick={doLookup}>Look up</Button>
        </div>
        {lookupErr && <Notice tone="err">{lookupErr}</Notice>}
        {lookup && <div style={{ marginTop: 12 }}><AssetCard a={lookup} web3={web3} me={me} refresh={refresh} /></div>}
      </Card>

      <Card className="span-2" title="My assets" subtitle="Everything currently held by the connected account.">
        {!account && <div className="empty">Connect a wallet.</div>}
        {account && !mine.length && <div className="empty">You hold no assets.</div>}
        {mine.map((a) => <AssetCard key={String(a.tokenId)} a={a} web3={web3} me={me} refresh={refresh} />)}
      </Card>
    </div>
  );
}
