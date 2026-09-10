import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import QRCode from "qrcode";
import { describeError, fmtTime, isZero, ROLES, STATUS, STATUS_LABEL } from "../lib/contracts";
import { hashDoc, verifyUrl, verifyHash } from "../lib/docs";
import DocLink from "../components/DocLink";
import { Addr, Badge, Button, Card, Explain, Field, Input, KV, Notice, RoleChip, Select } from "../lib/ui";

const KIND_LABEL = {
  identity: "a person (by address)",
  staff: "a person (by Staff ID)",
  asset: "an asset (by number)",
  certificate: "a certificate (by id)",
};
const PLACEHOLDER = { identity: "0x…", staff: "STAFF-1001", asset: "1", certificate: "0x… (64 hex characters)" };

export default function VerifyPanel({ web3, verifyTarget }) {
  const { contracts } = web3;
  const [kind, setKind] = useState(verifyTarget?.kind ?? "asset");
  const [id, setId] = useState(verifyTarget?.id ?? "");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (verifyTarget) {
      setKind(verifyTarget.kind);
      setId(verifyTarget.id);
      run(verifyTarget.kind, verifyTarget.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyTarget, contracts]);

  const valid =
    (kind === "identity" && isAddress(id)) ||
    (kind === "staff" && id.trim().length > 0) ||
    (kind === "asset" && /^\d+$/.test(id.trim())) ||
    (kind === "certificate" && /^0x[0-9a-fA-F]{64}$/.test(id.trim()));

  async function run(k = kind, v = id) {
    if (!contracts) return;
    setBusy(true);
    setResult(null);
    setQr(null);
    try {
      let r;
      if (k === "staff") {
        const address = await contracts.onboarding.resolveStaffId(v.trim());
        if (isZero(address)) r = { found: false, message: `No one holds Staff ID “${v.trim()}”.` };
        else r = await loadIdentity(contracts, address);
      } else if (k === "identity") {
        r = await loadIdentity(contracts, v.trim());
      } else if (k === "asset") {
        r = await loadAsset(contracts, BigInt(v.trim()));
      } else {
        r = await loadCertificate(contracts, v.trim());
      }
      setResult(r);
      if (r.found) {
        const url = verifyUrl(k, v.trim());
        window.history.replaceState(null, "", verifyHash(k, v.trim()));
        setQr({ url, image: await QRCode.toDataURL(url, { margin: 1, width: 168, color: { dark: "#eaf0fb", light: "#0e1420" } }) });
      }
    } catch (e) {
      setResult({ found: false, message: describeError(e).friendly });
    } finally {
      setBusy(false);
    }
  }

  const pastedHash = pasted ? hashDoc(pasted) : null;
  const pastedMatches = pastedHash && result?.fingerprint ? pastedHash.toLowerCase() === result.fingerprint.toLowerCase() : null;

  return (
    <div className="grid">
      <Card
        className="span-2"
        tone="accent"
        title="Verify anything against the ledger"
        subtitle="Public. No account needed. Employers, auditors, other departments — anyone can check a person, an asset or a certificate here, or scan its QR code."
      >
        <Explain title="How can this be trusted?">
          The chain never stores anyone's word for it — it stores <b>fingerprints</b> (hashes) and <b>who</b> recorded
          them, in a log that cannot be edited. This page reads straight from the chain. If someone hands you a document,
          paste it below: it is fingerprinted in your browser and compared with what was recorded. A single changed
          character gives a different fingerprint, so a forged or edited document can never verify.
        </Explain>
        <div className="row">
          <Field label="What are you checking?">
            <Select value={kind} onChange={(e) => { setKind(e.target.value); setId(""); setResult(null); setQr(null); }}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Reference">
            <Input placeholder={PLACEHOLDER[kind]} value={id} onChange={(e) => setId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && valid && run()} />
          </Field>
          <Field label="&nbsp;"><Button busy={busy} disabled={!valid} onClick={() => run()}>Verify</Button></Field>
        </div>

        {result && !result.found && <Notice tone="err">{result.message}</Notice>}

        {result?.found && (
          <div className="grid" style={{ marginTop: 10 }}>
            <div>
              <div className={`verify-banner ${result.tone}`}>
                <div className="big">{result.headline}</div>
                <div>{result.detail}</div>
              </div>
              <KV rows={result.rows} />
              {result.docUri && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: "var(--muted)", fontSize: 12.5, marginBottom: 4 }}>Document on record</div>
                  <DocLink uri={result.docUri} expectedHash={result.fingerprint} contracts={contracts} />
                </div>
              )}
            </div>

            <div>
              {qr && (
                <div className="qr">
                  <img src={qr.image} alt="QR code for this verification link" width={168} height={168} />
                  <div>
                    <b>Share or print this</b>
                    <p>Anyone who scans it lands on this exact check.</p>
                    <code className="url">{qr.url}</code>
                    <div className="actions" style={{ marginTop: 6 }}>
                      <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(qr.url)}>Copy link</Button>
                    </div>
                  </div>
                </div>
              )}

              {result.fingerprint && (
                <div style={{ marginTop: 16 }}>
                  <Field
                    label="Been handed a copy of this document? Paste it to check it's genuine"
                    hint={pastedHash ? `Fingerprint of what you pasted: ${pastedHash}` : "Fingerprinted in your browser; nothing is uploaded."}
                  >
                    <textarea className="input mono" rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="paste the full document text exactly as you received it" />
                  </Field>
                  {pastedMatches !== null && (
                    <Notice tone={pastedMatches ? "ok" : "err"}>
                      {pastedMatches
                        ? "✔ Genuine — this document matches the fingerprint recorded on the ledger."
                        : "✘ Does not match — this is not the document that was recorded (it was edited, or it is a different document)."}
                    </Notice>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loaders — each returns a uniform shape for the page
// ---------------------------------------------------------------------------

async function loadIdentity(contracts, address) {
  const [identity, did, roles, profile, creds] = await Promise.all([
    contracts.did.getIdentity(address),
    contracts.did.didOf(address),
    contracts.roles.rolesOf(address),
    contracts.onboarding ? contracts.onboarding.profileOf(address) : Promise.resolve(null),
    contracts.did.credentialsOf(address),
  ]);
  if (!identity.exists) return { found: false, message: `${address} has no Digital ID on this ledger.` };

  const held = [];
  if (roles.isRootAdmin) held.push(ROLES.DEFAULT_ADMIN);
  if (roles.isAdmin) held.push(ROLES.ADMIN);
  if (roles.isIssuer) held.push(ROLES.ISSUER);
  if (roles.isAuditor) held.push(ROLES.AUDITOR);
  if (roles.isHod) held.push(ROLES.HOD);
  if (roles.isUser) held.push(ROLES.USER);

  const name = profile?.staffId ? `${profile.displayName || "—"} · ${profile.staffId}` : null;
  const onboarded = profile ? Number(await contracts.onboarding.statusOf(address)) : STATUS.NONE;

  return {
    found: true,
    tone: identity.active ? "ok" : "err",
    headline: identity.active ? "✔ Active Digital ID" : "✘ Suspended Digital ID",
    detail: name ? `${name}${profile.department ? " — " + profile.department : ""}` : "No staff profile recorded.",
    fingerprint: identity.docHash,
    docUri: identity.docURI,
    rows: [
      ["Person", <Addr value={address} full />],
      ["ID", <code>{did}</code>],
      ["Onboarding", <Badge tone={onboarded === STATUS.APPROVED ? "ok" : "muted"}>{STATUS_LABEL[onboarded]}</Badge>],
      ["Roles", held.length ? held.map((r) => <RoleChip key={r} role={r} />) : <span className="empty">none</span>],
      ["Certificates held", String(creds.length)],
      ["ID created", fmtTime(identity.createdAt)],
      ["Document fingerprint", <code>{identity.docHash}</code>],
    ],
  };
}

async function loadAsset(contracts, tokenId) {
  let owner;
  try {
    owner = await contracts.nft.ownerOf(tokenId);
  } catch {
    return { found: false, message: `Asset #${tokenId} does not exist on this ledger (or was retired).` };
  }
  const [asset, uri, prov, ownerDID, issuerProfile] = await Promise.all([
    contracts.nft.getAsset(tokenId),
    contracts.nft.tokenURI(tokenId),
    contracts.nft.provenanceOf(tokenId),
    contracts.nft.ownerDID(tokenId),
    contracts.onboarding ? contracts.onboarding.profileOf((await contracts.nft.getAsset(tokenId)).issuer) : Promise.resolve(null),
  ]);
  const issuerName = issuerProfile?.staffId ? `${issuerProfile.displayName} (${issuerProfile.staffId})` : null;
  return {
    found: true,
    tone: asset.frozen ? "warn" : "ok",
    headline: asset.frozen ? "⚠ Genuine, but frozen by an admin" : "✔ Genuine asset on the ledger",
    detail: `Asset #${tokenId} · ${asset.category || "uncategorised"} · registered ${fmtTime(asset.createdAt)}${issuerName ? " by " + issuerName : ""}`,
    fingerprint: asset.contentHash,
    docUri: uri,
    rows: [
      ["Current owner", <><Addr value={owner} /> <code style={{ color: "var(--muted)" }}>{ownerDID}</code></>],
      ["Registered by", <Addr value={asset.issuer} />],
      ["Times it changed hands", String(Math.max(0, prov.length - 1))],
      ["Content fingerprint", <code>{asset.contentHash}</code>],
    ],
  };
}

async function loadCertificate(contracts, credentialId) {
  const [cred, valid] = await Promise.all([contracts.did.getCredential(credentialId), contracts.did.isCredentialValid(credentialId)]);
  if (!cred.exists) return { found: false, message: "No certificate with that id exists on this ledger." };
  return {
    found: true,
    tone: valid ? "ok" : "err",
    headline: valid ? "✔ Valid certificate" : cred.revoked ? "✘ Certificate was revoked" : "✘ Certificate is not valid",
    detail: `Issued ${fmtTime(cred.issuedAt)}${cred.expiresAt > 0n ? ", valid until " + fmtTime(cred.expiresAt) : ", no expiry"}`,
    fingerprint: cred.claimHash,
    docUri: null,
    rows: [
      ["About", <Addr value={cred.subject} full />],
      ["Issued by", <Addr value={cred.issuer} />],
      ["Certifies (schema)", <code>{cred.schema}</code>],
      ["Evidence fingerprint", <code>{cred.claimHash}</code>],
    ],
  };
}
