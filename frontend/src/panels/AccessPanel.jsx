import { useState } from "react";
import { isAddress } from "ethers";
import { describeError, fmtTime, LEVEL_INFO, LEVELS, toUnix } from "../lib/contracts";
import { Addr, Badge, Button, Card, Explain, Field, Input, Notice, Select, Table, useTx } from "../lib/ui";

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
      setCheck({ ...check, result: null, err: describeError(e).friendly });
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
      setList({ ...list, rows: null, err: describeError(e).friendly });
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
      setSignErr(describeError(e).friendly);
    }
  };

  const submitSigned = () => {
    const { req, signer: s, signature } = JSON.parse(submitJson);
    return contracts.policy.grantAccessWithSignature(req, s, signature);
  };

  return (
    <div className="grid">
      <Card title="Share an asset" subtitle="Owners can share what they own. Admins can share anything. Someone with Manage access can pass on View or Edit.">
        <Explain title="How sharing works">
          <ul>
            <li><b>View</b> — can open and read. <b>Edit</b> — can also change. <b>Manage</b> — can also share View/Edit with others.</li>
            <li>The person you share with must have an active Digital ID.</li>
            <li>Sharing can have an end date. It can also be taken back at any time.</li>
            <li>If the asset is sent to a new owner, <b>every share is cancelled automatically</b>. The new owner starts clean.</li>
          </ul>
        </Explain>
        <div className="row">
          <Field label="Asset #"><Input type="number" min="1" value={form.tokenId} onChange={f("tokenId")} /></Field>
          <Field label="Access level" hint={LEVEL_INFO[Number(form.level)]?.desc}>
            <Select value={form.level} onChange={f("level")}>
              {LEVEL_INFO.slice(1).map((l, i) => <option key={l.label} value={i + 1}>{l.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Share with"><Input mono placeholder="their address 0x…" value={form.grantee} onChange={f("grantee")} /></Field>
        <Field label="Until (optional)" hint="Leave empty for no end date."><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!valid}
            onClick={() => tx.run(`Share ${LEVELS[form.level]} access`, () =>
              contracts.policy.grantAccess(BigInt(form.tokenId), form.grantee, Number(form.level), toUnix(form.expiry)))}>
            Share
          </Button>
          <Button variant="danger" busy={tx.busy} disabled={!valid}
            onClick={() => tx.run("Take access back", () => contracts.policy.revokeAccess(BigInt(form.tokenId), form.grantee))}>
            Take back
          </Button>
          <Button variant="ghost" busy={tx.busy} disabled={!valid || !signer} onClick={sign} title="Sign the share now; anyone can submit it for you later">
            Sign now, submit later
          </Button>
        </div>
        <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
        {signErr && <Notice tone="err">{signErr}</Notice>}
        {signed && (
          <Field label="Your signed share — give this to anyone; they can submit it below on your behalf" hint="It contains a one-time number and a 1-hour deadline, so it can't be reused.">
            <textarea className="input mono" rows={8} readOnly value={signed} />
          </Field>
        )}
      </Card>

      <Card title="Check what someone can do" subtitle="Their access right now, after every rule is applied — expiry, ownership changes, suspended IDs.">
        <div className="row">
          <Field label="Asset #"><Input type="number" min="1" value={check.tokenId} onChange={(e) => setCheck({ ...check, tokenId: e.target.value })} /></Field>
          <Field label="Person"><Input mono placeholder="0x…" value={check.address} onChange={(e) => setCheck({ ...check, address: e.target.value.trim() })} /></Field>
        </div>
        <div className="actions">
          <Button variant="ghost" disabled={!check.tokenId || !isAddress(check.address)} onClick={doCheck}>Check</Button>
        </div>
        {check.err && <Notice tone="err">{check.err}</Notice>}
        {check.result !== null && (
          <Notice tone={check.result > 0 ? "ok" : "warn"}>
            <b>{LEVELS[check.result]}</b>{check.result === 3 ? " — this is the owner, or someone with Manage access" : ""}. {LEVEL_INFO[check.result].desc}
          </Notice>
        )}

        <h4 style={{ marginTop: 20 }}>Everyone an asset is shared with</h4>
        <div className="row">
          <Input type="number" min="1" placeholder="asset #" value={list.tokenId} onChange={(e) => setList({ ...list, tokenId: e.target.value })} style={{ maxWidth: 160 }} />
          <Button variant="ghost" disabled={!list.tokenId} onClick={doList}>List</Button>
        </div>
        {list.err && <Notice tone="err">{list.err}</Notice>}
        {list.rows && (
          <div style={{ marginTop: 12 }}>
            <Table
              head={["Person", "Was given", "Has now", "Shared by", "Until", "Note"]}
              empty="This asset has never been shared."
              rows={list.rows.map((r) => [
                <Addr value={r.grantee} />,
                <Badge>{LEVELS[Number(r.grant.level)]}</Badge>,
                <Badge tone={r.level > 0 ? "ok" : "err"}>{LEVELS[r.level]}</Badge>,
                <Addr value={r.grant.grantedBy} />,
                r.grant.expiresAt > 0n ? fmtTime(r.grant.expiresAt) : "no end date",
                r.grant.revoked ? "taken back" : r.level === 0 ? "no longer valid (expired, asset changed hands, or ID suspended)" : "",
              ])}
            />
          </div>
        )}
      </Card>

      <Card className="span-2" title="Submit a share someone signed" subtitle="Paste what “Sign now, submit later” produced. You pay the small network fee; the signer's authority is what gets checked.">
        <textarea className="input mono" rows={6} value={submitJson} onChange={(e) => setSubmitJson(e.target.value)} placeholder='{"req":{…},"signer":"0x…","signature":"0x…"}' />
        <div className="actions">
          <Button busy={tx.busy} disabled={!submitJson.trim()} onClick={() => tx.run("Submit signed share", submitSigned)}>Submit</Button>
        </div>
      </Card>
    </div>
  );
}
