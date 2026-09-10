import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { fmtTime, GRANTABLE_ROLES, ROLE_LABEL, ROLES, toUnix } from "../lib/contracts";
import { Badge, Button, Card, Field, Input, KV, Notice, Select, Table, useTx } from "../lib/ui";

const ALL_ROLES = [["ROOT", ROLES.DEFAULT_ADMIN], ...GRANTABLE_ROLES];

async function loadRoles(contracts, addr) {
  const r = await contracts.roles.rolesOf(addr);
  const flags = { ROOT: r.isRootAdmin, ADMIN: r.isAdmin, ISSUER: r.isIssuer, AUDITOR: r.isAuditor, USER: r.isUser };
  const rows = [];
  for (const [label, role] of ALL_ROLES) {
    const [raw, expiry] = await Promise.all([contracts.roles.hasRole(role, addr), contracts.roles.roleExpiry(role, addr)]);
    if (raw || flags[label]) rows.push({ label, valid: flags[label], raw, expiry });
  }
  return rows;
}

export default function RolesPanel({ web3, me, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [mine, setMine] = useState([]);
  const [form, setForm] = useState({ address: "", role: ROLES.USER, expiry: "" });
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookup, setLookup] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts || !account) return;
    loadRoles(contracts, account).then(setMine).catch(() => setMine([]));
  }, [contracts, account, refreshKey]);

  const doLookup = async () => {
    setLookupErr(null);
    try {
      const [rows, verified] = await Promise.all([loadRoles(contracts, lookupAddr), contracts.did.isVerified(lookupAddr)]);
      setLookup({ rows, verified });
    } catch (e) {
      setLookupErr(e.shortMessage || e.message);
    }
  };

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const canManage = me?.isAdmin;

  const rolesTable = (rows) => (
    <Table
      head={["Role", "Status", "Expires"]}
      empty="No roles."
      rows={rows.map((r) => [
        <Badge tone="accent">{r.label}</Badge>,
        <Badge tone={r.valid ? "ok" : "err"}>{r.valid ? "valid" : "held but not valid"}</Badge>,
        r.expiry > 0n ? fmtTime(r.expiry) : "never",
      ])}
    />
  );

  return (
    <div className="grid">
      <Card title="My roles" subtitle="Computed live by RoleManager.hasValidRole: role + not expired + identity active.">
        {account ? rolesTable(mine) : <div className="empty">Connect a wallet.</div>}
      </Card>

      <Card
        title="Grant / revoke a role"
        subtitle="ADMIN can manage ISSUER, AUDITOR and USER. Only ROOT can manage ADMIN."
        right={canManage ? <Badge tone="ok">you are an ADMIN</Badge> : <Badge tone="warn">requires ADMIN_ROLE</Badge>}
      >
        <Field label="Account" hint="Must already hold an active DID — the contract refuses otherwise.">
          <Input mono placeholder="0x…" value={form.address} onChange={f("address")} />
        </Field>
        <div className="row">
          <Field label="Role">
            <Select value={form.role} onChange={f("role")}>
              {GRANTABLE_ROLES.map(([label, role]) => <option key={role} value={role}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Expires (optional)"><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
        </div>
        <div className="actions">
          <Button busy={tx.busy} disabled={!isAddress(form.address)}
            onClick={() => tx.run(`Grant ${ROLE_LABEL[form.role]}`, () =>
              form.expiry
                ? contracts.roles.grantRoleWithExpiry(form.role, form.address, toUnix(form.expiry))
                : contracts.roles.grantRole(form.role, form.address))}>
            Grant
          </Button>
          <Button variant="danger" busy={tx.busy} disabled={!isAddress(form.address)}
            onClick={() => tx.run(`Revoke ${ROLE_LABEL[form.role]}`, () => contracts.roles.revokeRole(form.role, form.address))}>
            Revoke
          </Button>
        </div>
        <Notice tone={tx.tone}>{tx.msg}</Notice>
      </Card>

      <Card title="Look up roles of any address">
        <div className="row">
          <Input mono placeholder="0x…" value={lookupAddr} onChange={(e) => setLookupAddr(e.target.value.trim())} />
          <Button variant="ghost" disabled={!isAddress(lookupAddr)} onClick={doLookup}>Look up</Button>
        </div>
        {lookupErr && <Notice tone="err">{lookupErr}</Notice>}
        {lookup && (
          <div style={{ marginTop: 12 }}>
            <KV rows={[["Identity", <Badge tone={lookup.verified ? "ok" : "err"}>{lookup.verified ? "active" : "none / suspended"}</Badge>]]} />
            <div style={{ marginTop: 10 }}>{rolesTable(lookup.rows)}</div>
          </div>
        )}
      </Card>

      <Card title="How roles work here">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: "var(--muted)" }}>
          <li><b style={{ color: "var(--text)" }}>No identity, no role.</b> Granting to an address without an active DID reverts.</li>
          <li><b style={{ color: "var(--text)" }}>Suspend an identity, and every role it holds stops working</b> — instantly, with no per-role revocation.</li>
          <li><b style={{ color: "var(--text)" }}>Roles can expire.</b> An expired role is treated as absent, though the raw grant stays visible for audit.</li>
          <li><b style={{ color: "var(--text)" }}>Admins are not exempt.</b> An admin whose identity is suspended loses admin powers too.</li>
          <li>Hierarchy: <Badge>ROOT</Badge> → <Badge>ADMIN</Badge> → <Badge>ISSUER</Badge> <Badge>AUDITOR</Badge> <Badge>USER</Badge></li>
        </ul>
      </Card>
    </div>
  );
}
