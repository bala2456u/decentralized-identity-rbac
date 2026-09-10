import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { describeError, fmtTime, hashText, ROLES, toUnix } from "../lib/contracts";
import { Addr, Badge, Button, Card, Empty, Explain, Field, Input, KV, Notice, RoleChip, Table, useTx } from "../lib/ui";

export default function IdentityPanel(props) {
  return (
    <div className="grid">
      <MyIdentity {...props} />
      <Lookup {...props} />
      <Certificates {...props} />
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
      <Card title="My Digital ID">
        <Empty>Pick a person (or sign in with a wallet) to create or manage a Digital ID.</Empty>
      </Card>
    );
  }

  if (!identity || !identity.exists) {
    return (
      <Card
        tone="accent"
        title="Create my Digital ID"
        subtitle="You create it yourself. Nobody — not even an admin — can create it for you, and it can never be moved to another account."
      >
        <Explain>
          Your Digital ID is derived from your account's address, so it's unique and can't be faked. The details about you
          (name, department, public key…) live in a document you keep elsewhere; only its <b>fingerprint</b> is stored on
          the chain. That proves the document hasn't changed without ever exposing what's in it.
        </Explain>
        <Field label="Link to your ID document" hint="Where the full document is stored — an IPFS link, for example. Keep personal details off the chain.">
          <Input value={docURI} onChange={(e) => setDocURI(e.target.value)} />
        </Field>
        <Field
          label="ID document content"
          hint={docText ? `Fingerprint that will be recorded: ${hashText(docText)}` : "Only a fingerprint of this text is recorded — never the text itself."}
        >
          <Input value={docText} onChange={(e) => setDocText(e.target.value)} placeholder='e.g. {"name":"Dave Kumar","department":"Procurement"}' />
        </Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!docText} onClick={() => tx.run("Create Digital ID", () => contracts.did.register(docURI, hashText(docText)))}>
            Create my Digital ID
          </Button>
        </div>
        <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
      </Card>
    );
  }

  const active = identity.active;
  return (
    <Card
      title="My Digital ID"
      right={<Badge tone={active ? "ok" : "err"}>{active ? "active" : identity.adminLocked ? "suspended by an admin" : "suspended"}</Badge>}
    >
      <KV
        rows={[
          ["Your ID", <code>{did}</code>],
          ["Controlled by", <Addr value={identity.controller} full />],
          ["Created", fmtTime(identity.createdAt)],
          ["Last changed", fmtTime(identity.updatedAt)],
          ["Document link", <code>{identity.docURI}</code>],
          ["Document fingerprint", <code>{identity.docHash}</code>],
        ]}
      />
      <div className="actions">
        {active ? (
          <Button variant="danger" size="sm" busy={tx.busy} onClick={() => tx.run("Suspend my ID", () => contracts.did.deactivate(account))}>
            Suspend my ID
          </Button>
        ) : (
          <Button size="sm" busy={tx.busy} onClick={() => tx.run("Reactivate my ID", () => contracts.did.reactivate(account))}>
            Reactivate my ID
          </Button>
        )}
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          While suspended, all your roles, assets and shares stop working. Reactivating brings them back.
        </span>
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />

      <Field label="Lost or compromised key? Move control to a new one" hint="The new key gains the right to manage this ID. Your ID itself stays exactly where it is.">
        <div className="row">
          <Input mono placeholder="new key's address 0x…" value={newController} onChange={(e) => setNewController(e.target.value.trim())} />
          <Button size="sm" variant="ghost" busy={tx.busy} disabled={!isAddress(newController)}
            onClick={() => tx.run("Move control", () => contracts.did.rotateController(account, newController))}>
            Move control
          </Button>
        </div>
      </Field>
      <Field label="Update my ID document">
        <div className="row">
          <Input placeholder="new document link" value={docURI} onChange={(e) => setDocURI(e.target.value)} />
          <Input placeholder="new document content" value={docText} onChange={(e) => setDocText(e.target.value)} />
          <Button size="sm" variant="ghost" busy={tx.busy} disabled={!docText}
            onClick={() => tx.run("Update document", () => contracts.did.updateDocument(account, hashText(docText), docURI))}>
            Update
          </Button>
        </div>
      </Field>
      <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
    </Card>
  );
}

function Lookup({ web3, me, refresh, refreshKey }) {
  const { contracts } = web3;
  const [addr, setAddr] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const tx = useTx(refresh);

  // keep the result fresh after an admin action below
  useEffect(() => {
    if (result && isAddress(addr)) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const lookup = async () => {
    setErr(null);
    try {
      const [identity, did, roles] = await Promise.all([
        contracts.did.getIdentity(addr),
        contracts.did.didOf(addr),
        contracts.roles.rolesOf(addr),
      ]);
      const held = [];
      if (roles.isRootAdmin) held.push(ROLES.DEFAULT_ADMIN);
      if (roles.isAdmin) held.push(ROLES.ADMIN);
      if (roles.isIssuer) held.push(ROLES.ISSUER);
      if (roles.isAuditor) held.push(ROLES.AUDITOR);
      if (roles.isUser) held.push(ROLES.USER);
      setResult({ identity, did, held });
    } catch (e) {
      setErr(describeError(e).friendly);
      setResult(null);
    }
  };

  return (
    <Card title="Check someone's Digital ID" subtitle="Anyone can check anyone. That openness is what makes an ID trustworthy.">
      <div className="row">
        <Input mono placeholder="their address 0x…" value={addr} onChange={(e) => setAddr(e.target.value.trim())} />
        <Button variant="ghost" disabled={!isAddress(addr)} onClick={lookup}>Check</Button>
      </div>
      {err && <Notice tone="err">{err}</Notice>}
      {result && !result.identity.exists && <Notice tone="warn">This address has no Digital ID. It can't hold roles or assets until it creates one.</Notice>}
      {result && result.identity.exists && (
        <div style={{ marginTop: 14 }}>
          <KV
            rows={[
              ["Their ID", <code>{result.did}</code>],
              ["Status", <Badge tone={result.identity.active ? "ok" : "err"}>{result.identity.active ? "active" : "suspended"}</Badge>],
              ["Roles", result.held.length ? result.held.map((r) => <RoleChip key={r} role={r} />) : <span className="empty">none</span>],
              ["Controlled by", <Addr value={result.identity.controller} full />],
              ["Created", fmtTime(result.identity.createdAt)],
              ["Document link", <code>{result.identity.docURI}</code>],
            ]}
          />
          {me?.isAdmin && (
            <div className="actions">
              {result.identity.active ? (
                <Button size="sm" variant="danger" busy={tx.busy} onClick={() => tx.run("Suspend this ID", () => contracts.did.deactivate(addr))}>
                  Suspend this ID
                </Button>
              ) : (
                <Button size="sm" busy={tx.busy} onClick={() => tx.run("Reactivate this ID", () => contracts.did.reactivate(addr))}>
                  Reactivate this ID
                </Button>
              )}
              <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
                Admin action. Suspending stops all their roles, assets and shares at once; only an admin can lift an admin suspension.
              </span>
            </div>
          )}
          <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
        </div>
      )}
    </Card>
  );
}

function Certificates({ web3, me, refresh, refreshKey }) {
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
      setVerified({ error: describeError(e).friendly });
    }
  };

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card
      className="span-2"
      title="Certificates"
      subtitle="An Issuer can certify a fact about a person — “employee verified”, “passed training”, “KYC complete”. Anyone can check it later. Certificates can expire and can be revoked."
    >
      <div className="grid">
        <div>
          <h4>My certificates</h4>
          <Table
            head={["Certifies", "Issued by", "Issued", "Valid until", "Status", ""]}
            empty={account ? "Nobody has certified anything about this person yet." : "Pick a person first."}
            rows={mine.map(({ id, cred, valid }) => [
              <code title={cred.schema}>{cred.schema.slice(0, 10)}…</code>,
              <Addr value={cred.issuer} />,
              fmtTime(cred.issuedAt),
              cred.expiresAt > 0n ? fmtTime(cred.expiresAt) : "no expiry",
              <Badge tone={valid ? "ok" : "err"}>{valid ? "valid" : cred.revoked ? "revoked" : "not valid"}</Badge>,
              (me?.isAdmin || cred.issuer.toLowerCase() === account?.toLowerCase()) && !cred.revoked ? (
                <Button size="sm" variant="danger" busy={tx.busy} onClick={() => tx.run("Revoke certificate", () => contracts.did.revokeCredential(id))}>revoke</Button>
              ) : null,
            ])}
          />

          <h4 style={{ marginTop: 18 }}>Check a certificate</h4>
          <div className="row">
            <Input mono placeholder="certificate id (0x…)" value={verifyId} onChange={(e) => setVerifyId(e.target.value.trim())} />
            <Button variant="ghost" disabled={!/^0x[0-9a-fA-F]{64}$/.test(verifyId)} onClick={verify}>Check</Button>
          </div>
          {verified?.error && <Notice tone="err">{verified.error}</Notice>}
          {verified?.cred && !verified.cred.exists && <Notice tone="warn">No certificate with that ID exists.</Notice>}
          {verified?.cred?.exists && (
            <Notice tone={verified.valid ? "ok" : "err"}>
              {verified.valid ? "This certificate is valid." : "This certificate is NOT valid."} About <Addr value={verified.cred.subject} />, issued by{" "}
              <Addr value={verified.cred.issuer} />{verified.cred.revoked && " — it was revoked"}.
            </Notice>
          )}
        </div>

        <div>
          <h4>
            Issue a certificate{" "}
            {me?.isIssuer ? <Badge tone="ok">you are an Issuer</Badge> : <Badge tone="warn">Issuers only</Badge>}
          </h4>
          <Field label="Who it's about" hint="They must have an active Digital ID.">
            <Input mono placeholder="0x…" value={form.subject} onChange={f("subject")} />
          </Field>
          <div className="row">
            <Field label="What it certifies" hint="e.g. EMPLOYEE_VERIFIED"><Input value={form.schema} onChange={f("schema")} /></Field>
            <Field label="Evidence" hint="e.g. an HR record reference — only its fingerprint is recorded"><Input value={form.claim} onChange={f("claim")} /></Field>
          </div>
          <Field label="Valid until (optional)"><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
          <div className="actions">
            <Button busy={tx.busy} disabled={!isAddress(form.subject) || !form.schema || !form.claim}
              onClick={() => tx.run("Issue certificate", () =>
                contracts.did.issueCredential(form.subject, hashText(form.schema), hashText(form.claim), toUnix(form.expiry)))}>
              Issue certificate
            </Button>
          </div>
          <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
        </div>
      </div>
    </Card>
  );
}
