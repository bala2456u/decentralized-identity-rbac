import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { fmtTime, hashText, ROLE_LABEL, ROLES, toUnix } from "../lib/contracts";
import { Addr, Badge, Button, Card, Field, Input, KV, Notice, Table, useTx } from "../lib/ui";

export default function IdentityPanel(props) {
  return (
    <div className="grid">
      <MyIdentity {...props} />
      <Lookup {...props} />
      <Credentials {...props} />
    </div>
  );
}

function MyIdentity({ web3, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [identity, setIdentity] = useState(null);
  const [did, setDid] = useState("");
  const [docURI, setDocURI] = useState("ipfs://");
  const [docText, setDocText] = useState("");
  const [newController, setNewController] = useState("");
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts || !account) return;
    Promise.all([contracts.did.getIdentity(account), contracts.did.didOf(account)])
      .then(([id, d]) => { setIdentity(id); setDid(d); })
      .catch(() => setIdentity(null));
  }, [contracts, account, refreshKey]);

  if (!account) {
    return (
      <Card title="My identity">
        <div className="empty">Connect a wallet to create or manage your DID.</div>
      </Card>
    );
  }

  if (!identity || !identity.exists) {
    return (
      <Card title="Create my identity" subtitle="Self-sovereign: only you can register your own DID. Nobody can do it for you.">
        <Field label="DID document URI" hint="Where the full document lives (IPFS CID, URL). Never put personal data on-chain.">
          <Input value={docURI} onChange={(e) => setDocURI(e.target.value)} />
        </Field>
        <Field label="Document content (hashed client-side)" hint={docText ? `keccak256: ${hashText(docText)}` : "The hash of this text is what gets anchored on-chain."}>
          <Input value={docText} onChange={(e) => setDocText(e.target.value)} placeholder='{"name":"…","publicKey":"…"}' />
        </Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!docText} onClick={() => tx.run("Register DID", () => contracts.did.register(docURI, hashText(docText)))}>
            Register DID
          </Button>
        </div>
        <Notice tone={tx.tone}>{tx.msg}</Notice>
      </Card>
    );
  }

  const active = identity.active;
  return (
    <Card
      title="My identity"
      right={<Badge tone={active ? "ok" : "err"}>{active ? "active" : identity.adminLocked ? "suspended by admin" : "suspended"}</Badge>}
    >
      <KV
        rows={[
          ["DID", <code>{did}</code>],
          ["Controller", <Addr value={identity.controller} full />],
          ["Created", fmtTime(identity.createdAt)],
          ["Updated", fmtTime(identity.updatedAt)],
          ["Document", <code>{identity.docURI}</code>],
          ["Doc hash", <code>{identity.docHash}</code>],
        ]}
      />
      <div className="actions">
        {active ? (
          <Button variant="danger" size="sm" busy={tx.busy} onClick={() => tx.run("Deactivate identity", () => contracts.did.deactivate(account))}>
            Deactivate
          </Button>
        ) : (
          <Button size="sm" busy={tx.busy} onClick={() => tx.run("Reactivate identity", () => contracts.did.reactivate(account))}>
            Reactivate
          </Button>
        )}
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />
      <Field label="Rotate controller (key rotation / recovery)" hint="The new key gains the right to edit this DID document. The identity itself never moves.">
        <div className="row">
          <Input mono placeholder="0x…" value={newController} onChange={(e) => setNewController(e.target.value)} />
          <Button size="sm" variant="ghost" busy={tx.busy} disabled={!isAddress(newController)}
            onClick={() => tx.run("Rotate controller", () => contracts.did.rotateController(account, newController))}>
            Rotate
          </Button>
        </div>
      </Field>
      <Field label="Update document">
        <div className="row">
          <Input placeholder="ipfs://new-cid" value={docURI} onChange={(e) => setDocURI(e.target.value)} />
          <Input placeholder="new document content" value={docText} onChange={(e) => setDocText(e.target.value)} />
          <Button size="sm" variant="ghost" busy={tx.busy} disabled={!docText}
            onClick={() => tx.run("Update document", () => contracts.did.updateDocument(account, hashText(docText), docURI))}>
            Update
          </Button>
        </div>
      </Field>
      <Notice tone={tx.tone}>{tx.msg}</Notice>
    </Card>
  );
}

function Lookup({ web3 }) {
  const { contracts } = web3;
  const [addr, setAddr] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const lookup = async () => {
    setErr(null);
    try {
      const [identity, did, roles] = await Promise.all([
        contracts.did.getIdentity(addr),
        contracts.did.didOf(addr),
        contracts.roles.rolesOf(addr),
      ]);
      const held = [];
      if (roles.isRootAdmin) held.push(ROLE_LABEL[ROLES.DEFAULT_ADMIN]);
      if (roles.isAdmin) held.push(ROLE_LABEL[ROLES.ADMIN]);
      if (roles.isIssuer) held.push(ROLE_LABEL[ROLES.ISSUER]);
      if (roles.isAuditor) held.push(ROLE_LABEL[ROLES.AUDITOR]);
      if (roles.isUser) held.push(ROLE_LABEL[ROLES.USER]);
      setResult({ identity, did, held });
    } catch (e) {
      setErr(e.shortMessage || e.message);
      setResult(null);
    }
  };

  return (
    <Card title="Verify an identity" subtitle="Anyone can check any address — that is the point of a public registry.">
      <div className="row">
        <Input mono placeholder="0x…" value={addr} onChange={(e) => setAddr(e.target.value.trim())} />
        <Button variant="ghost" disabled={!isAddress(addr)} onClick={lookup}>Look up</Button>
      </div>
      {err && <Notice tone="err">{err}</Notice>}
      {result && !result.identity.exists && <Notice tone="warn">No identity registered for this address.</Notice>}
      {result && result.identity.exists && (
        <div style={{ marginTop: 12 }}>
          <KV
            rows={[
              ["DID", <code>{result.did}</code>],
              ["Status", <Badge tone={result.identity.active ? "ok" : "err"}>{result.identity.active ? "active" : "suspended"}</Badge>],
              ["Roles", result.held.length ? result.held.map((r) => <Badge key={r}>{r}</Badge>) : <span className="empty">none</span>],
              ["Controller", <Addr value={result.identity.controller} full />],
              ["Registered", fmtTime(result.identity.createdAt)],
              ["Document", <code>{result.identity.docURI}</code>],
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function Credentials({ web3, me, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [mine, setMine] = useState([]);
  const [form, setForm] = useState({ subject: "", schema: "", claim: "", expiry: "" });
  const [verifyId, setVerifyId] = useState("");
  const [verified, setVerified] = useState(null);
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts || !account) return;
    (async () => {
      const ids = await contracts.did.credentialsOf(account);
      const rows = await Promise.all(
        ids.map(async (id) => ({ id, cred: await contracts.did.getCredential(id), valid: await contracts.did.isCredentialValid(id) }))
      );
      setMine(rows);
    })().catch(() => setMine([]));
  }, [contracts, account, refreshKey]);

  const verify = async () => {
    try {
      const [cred, valid] = await Promise.all([contracts.did.getCredential(verifyId), contracts.did.isCredentialValid(verifyId)]);
      setVerified({ cred, valid });
    } catch (e) {
      setVerified({ error: e.shortMessage || e.message });
    }
  };

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card className="span-2" title="Verifiable credentials" subtitle="Claims about an identity, signed by an ISSUER and anchored on-chain. Revocable, expirable.">
      <div className="grid">
        <div>
          <h4 style={{ margin: "0 0 8px" }}>Held by me</h4>
          <Table
            head={["Schema", "Issuer", "Issued", "Expires", "Status", ""]}
            empty={account ? "You hold no credentials." : "Connect a wallet."}
            rows={mine.map(({ id, cred, valid }) => [
              <code title={cred.schema}>{cred.schema.slice(0, 10)}…</code>,
              <Addr value={cred.issuer} />,
              fmtTime(cred.issuedAt),
              fmtTime(cred.expiresAt),
              <Badge tone={valid ? "ok" : "err"}>{valid ? "valid" : cred.revoked ? "revoked" : "invalid"}</Badge>,
              (me?.isAdmin || cred.issuer.toLowerCase() === account?.toLowerCase()) && !cred.revoked ? (
                <Button size="sm" variant="danger" busy={tx.busy} onClick={() => tx.run("Revoke credential", () => contracts.did.revokeCredential(id))}>revoke</Button>
              ) : null,
            ])}
          />

          <h4 style={{ margin: "16px 0 8px" }}>Verify a credential</h4>
          <div className="row">
            <Input mono placeholder="credential id (0x…)" value={verifyId} onChange={(e) => setVerifyId(e.target.value.trim())} />
            <Button variant="ghost" disabled={!/^0x[0-9a-fA-F]{64}$/.test(verifyId)} onClick={verify}>Verify</Button>
          </div>
          {verified?.error && <Notice tone="err">{verified.error}</Notice>}
          {verified?.cred && !verified.cred.exists && <Notice tone="warn">No such credential.</Notice>}
          {verified?.cred?.exists && (
            <Notice tone={verified.valid ? "ok" : "err"}>
              {verified.valid ? "VALID" : "NOT VALID"} — subject <Addr value={verified.cred.subject} /> · issuer <Addr value={verified.cred.issuer} />
              {verified.cred.revoked && " · revoked"}
            </Notice>
          )}
        </div>

        <div>
          <h4 style={{ margin: "0 0 8px" }}>Issue a credential {me?.isIssuer ? <Badge tone="ok">you are an ISSUER</Badge> : <Badge tone="warn">requires ISSUER_ROLE</Badge>}</h4>
          <Field label="Subject address"><Input mono placeholder="0x…" value={form.subject} onChange={f("subject")} /></Field>
          <div className="row">
            <Field label="Schema" hint="e.g. KYC_LEVEL_2, EMPLOYEE_VERIFIED"><Input value={form.schema} onChange={f("schema")} /></Field>
            <Field label="Claim (hashed)" hint="The evidence; only its hash goes on-chain"><Input value={form.claim} onChange={f("claim")} /></Field>
          </div>
          <Field label="Expires (optional)"><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
          <div className="actions">
            <Button busy={tx.busy} disabled={!isAddress(form.subject) || !form.schema || !form.claim}
              onClick={() => tx.run("Issue credential", () =>
                contracts.did.issueCredential(form.subject, hashText(form.schema), hashText(form.claim), toUnix(form.expiry)))}>
              Issue
            </Button>
          </div>
          <Notice tone={tx.tone}>{tx.msg}</Notice>
        </div>
      </div>
    </Card>
  );
}
