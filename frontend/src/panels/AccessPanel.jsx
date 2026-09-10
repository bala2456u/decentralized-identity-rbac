import { useState } from "react";
import { isAddress } from "ethers";
import { fmtTime, LEVELS, toUnix } from "../lib/contracts";
import { Addr, Badge, Button, Card, Field, Input, Notice, Select, Table, useTx } from "../lib/ui";

const GRANT_TYPES = {
  AccessGrant: [
    { name: "tokenId", type: "uint256" },
    { name: "grantee", type: "address" },
    { name: "level", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export default function AccessPanel({ web3, refresh }) {
  const { contracts, account, signer, chainId } = web3;
  const [form, setForm] = useState({ tokenId: "", grantee: "", level: "1", expiry: "" });
  const [check, setCheck] = useState({ tokenId: "", address: "", result: null, err: null });
  const [list, setList] = useState({ tokenId: "", rows: null, err: null });
  const [signed, setSigned] = useState("");
  const [submitJson, setSubmitJson] = useState("");
  const [signErr, setSignErr] = useState(null);
  const tx = useTx(refresh);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const valid = form.tokenId && isAddress(form.grantee);

  const doCheck = async () => {
    try {
      const level = await contracts.policy.effectiveLevel(BigInt(check.tokenId), check.address);
      setCheck({ ...check, result: Number(level), err: null });
    } catch (e) {
      setCheck({ ...check, result: null, err: "No such asset." });
    }
  };

  const doList = async () => {
    try {
      const all = await contracts.policy.granteesOf(BigInt(list.tokenId));
      const rows = await Promise.all(
        all.map(async (g) => {
          const [grant, level] = await Promise.all([
            contracts.policy.getGrant(BigInt(list.tokenId), g),
            contracts.policy.effectiveLevel(BigInt(list.tokenId), g),
          ]);
          return { grantee: g, grant, level: Number(level) };
        })
      );
      setList({ ...list, rows, err: null });
    } catch (e) {
      setList({ ...list, rows: null, err: "No such asset." });
    }
  };

  const sign = async () => {
    setSignErr(null);
    try {
      const nonce = await contracts.policy.nonces(account);
      const req = {
        tokenId: BigInt(form.tokenId).toString(),
        grantee: form.grantee,
        level: Number(form.level),
        expiresAt: toUnix(form.expiry),
        nonce: nonce.toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      const domain = { name: "YHackAccessPolicy", version: "1", chainId, verifyingContract: await contracts.policy.getAddress() };
      const signature = await signer.signTypedData(domain, GRANT_TYPES, req);
      setSigned(JSON.stringify({ req, signer: account, signature }, null, 2));
    } catch (e) {
      setSignErr(e.shortMessage || e.message);
    }
  };

  const submitSigned = () => {
    const { req, signer: s, signature } = JSON.parse(submitJson);
    return contracts.policy.grantAccessWithSignature(req, s, signature);
  };

  return (
    <div className="grid">
      <Card title="Grant or revoke access" subtitle="Owner, admin, or a MANAGE holder (for VIEW/EDIT only). Grantee needs an active DID.">
        <div className="row">
          <Field label="Token id"><Input type="number" min="1" value={form.tokenId} onChange={f("tokenId")} /></Field>
          <Field label="Level">
            <Select value={form.level} onChange={f("level")}>
              {LEVELS.slice(1).map((l, i) => <option key={l} value={i + 1}>{l}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Grantee"><Input mono placeholder="0x…" value={form.grantee} onChange={f("grantee")} /></Field>
        <Field label="Expires (optional)"><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!valid}
            onClick={() => tx.run(`Grant ${LEVELS[form.level]}`, () =>
              contracts.policy.grantAccess(BigInt(form.tokenId), form.grantee, Number(form.level), toUnix(form.expiry)))}>
            Grant
          </Button>
          <Button variant="danger" busy={tx.busy} disabled={!valid}
            onClick={() => tx.run("Revoke access", () => contracts.policy.revokeAccess(BigInt(form.tokenId), form.grantee))}>
            Revoke
          </Button>
          <Button variant="ghost" busy={tx.busy} disabled={!valid || !signer} onClick={sign} title="Sign an EIP-712 grant that anyone can submit for you">
            Sign instead (gasless)
          </Button>
        </div>
        <Notice tone={tx.tone}>{tx.msg}</Notice>
        {signErr && <Notice tone="err">{signErr}</Notice>}
        {signed && (
          <Field label="Signed grant — hand this to anyone; they can submit it below" hint="Contains a nonce and a 1-hour deadline, so it cannot be replayed.">
            <textarea className="input mono" rows={8} readOnly value={signed} />
          </Field>
        )}
      </Card>

      <Card title="Check access" subtitle="What level does an account effectively hold right now?">
        <div className="row">
          <Field label="Token id"><Input type="number" min="1" value={check.tokenId} onChange={(e) => setCheck({ ...check, tokenId: e.target.value })} /></Field>
          <Field label="Account"><Input mono placeholder="0x…" value={check.address} onChange={(e) => setCheck({ ...check, address: e.target.value.trim() })} /></Field>
        </div>
        <div className="actions">
          <Button variant="ghost" disabled={!check.tokenId || !isAddress(check.address)} onClick={doCheck}>Check</Button>
        </div>
        {check.err && <Notice tone="err">{check.err}</Notice>}
        {check.result !== null && (
          <Notice tone={check.result > 0 ? "ok" : "warn"}>
            Effective level: <b>{LEVELS[check.result]}</b>
            {check.result === 3 && " (owner or delegated manager)"}
          </Notice>
        )}

        <h4 style={{ margin: "18px 0 8px" }}>All grants on an asset</h4>
        <div className="row">
          <Input type="number" min="1" placeholder="token id" value={list.tokenId} onChange={(e) => setList({ ...list, tokenId: e.target.value })} style={{ maxWidth: 160 }} />
          <Button variant="ghost" disabled={!list.tokenId} onClick={doList}>List</Button>
        </div>
        {list.err && <Notice tone="err">{list.err}</Notice>}
        {list.rows && (
          <div style={{ marginTop: 10 }}>
            <Table
              head={["Grantee", "Granted", "Effective", "By", "Expires", "Note"]}
              empty="No grants were ever made on this asset."
              rows={list.rows.map((r) => [
                <Addr value={r.grantee} />,
                <Badge>{LEVELS[Number(r.grant.level)]}</Badge>,
                <Badge tone={r.level > 0 ? "ok" : "err"}>{LEVELS[r.level]}</Badge>,
                <Addr value={r.grant.grantedBy} />,
                r.grant.expiresAt > 0n ? fmtTime(r.grant.expiresAt) : "never",
                r.grant.revoked ? "revoked" : r.level === 0 ? "lapsed (expiry, transfer, or identity)" : "",
              ])}
            />
          </div>
        )}
      </Card>

      <Card className="span-2" title="Submit a signed grant" subtitle="Paste the JSON produced by “Sign instead”. The submitter pays gas; the signer's authority is what the contract checks.">
        <textarea className="input mono" rows={6} value={submitJson} onChange={(e) => setSubmitJson(e.target.value)} placeholder='{"req":{…},"signer":"0x…","signature":"0x…"}' />
        <div className="actions">
          <Button busy={tx.busy} disabled={!submitJson.trim()} onClick={() => tx.run("Submit signed grant", submitSigned)}>Submit</Button>
        </div>
      </Card>
    </div>
  );
}
