import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { describeError, fmtTime, GRANTABLE_ROLES, ROLE_INFO, ROLES, roleName, toUnix } from "../lib/contracts";
import { Badge, Button, Card, Empty, Explain, Field, Input, KV, Notice, RoleChip, Select, Table, useTx } from "../lib/ui";

const ALL_ROLES = [ROLES.DEFAULT_ADMIN, ...GRANTABLE_ROLES];

async function loadRoles(contracts, addr) {
  const r = await contracts.roles.rolesOf(addr);
  const valid = {
    [ROLES.DEFAULT_ADMIN]: r.isRootAdmin,
    [ROLES.ADMIN]: r.isAdmin,
    [ROLES.ISSUER]: r.isIssuer,
    [ROLES.AUDITOR]: r.isAuditor,
    [ROLES.HOD]: r.isHod,
    [ROLES.USER]: r.isUser,
  };
  const rows = [];
  for (const role of ALL_ROLES) {
    const [raw, expiry] = await Promise.all([contracts.roles.hasRole(role, addr), contracts.roles.roleExpiry(role, addr)]);
    if (raw || valid[role]) rows.push({ role, valid: valid[role], raw, expiry });
  }
  return rows;
}

function RolesTable({ rows }) {
  return (
    <Table
      head={["Role", "Status", "Valid until"]}
      empty="No roles."
      rows={rows.map((r) => [
        <RoleChip role={r.role} />,
        <Badge tone={r.valid ? "ok" : "err"}>{r.valid ? "in force" : "held, but not in force"}</Badge>,
        r.expiry > 0n ? fmtTime(r.expiry) : "no expiry",
      ])}
    />
  );
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
      setLookupErr(describeError(e).friendly);
    }
  };

  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid">
      <Card title="My roles" subtitle="Roles decide what you're allowed to do. A role only counts while your Digital ID is active and the role hasn't expired.">
        {account ? <RolesTable rows={mine} /> : <Empty>Pick a person first.</Empty>}
      </Card>

      <Card
        title="Give or remove a role"
        subtitle="Admins manage Issuer, Auditor and User. Only the Root admin can make someone an Admin."
        right={me?.isAdmin ? <Badge tone="ok">you are an Admin</Badge> : <Badge tone="warn">Admins only</Badge>}
      >
        <Field label="Person's address" hint="They must already have an active Digital ID — otherwise the system refuses.">
          <Input mono placeholder="0x…" value={form.address} onChange={f("address")} />
        </Field>
        <div className="row">
          <Field label="Role" hint={ROLE_INFO[form.role]?.desc}>
            <Select value={form.role} onChange={f("role")}>
              {GRANTABLE_ROLES.map((role) => <option key={role} value={role}>{roleName(role)}</option>)}
            </Select>
          </Field>
          <Field label="Valid until (optional)" hint="Leave empty for no expiry."><Input type="datetime-local" value={form.expiry} onChange={f("expiry")} /></Field>
        </div>
        <div className="actions">
          <Button busy={tx.busy} disabled={!isAddress(form.address)}
            onClick={() => tx.run(`Give ${roleName(form.role)} role`, () =>
              form.expiry
                ? contracts.roles.grantRoleWithExpiry(form.role, form.address, toUnix(form.expiry))
                : contracts.roles.grantRole(form.role, form.address))}>
            Give role
          </Button>
          <Button variant="danger" busy={tx.busy} disabled={!isAddress(form.address)}
            onClick={() => tx.run(`Remove ${roleName(form.role)} role`, () => contracts.roles.revokeRole(form.role, form.address))}>
            Remove role
          </Button>
        </div>
        <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
      </Card>

      <Card title="Check someone's roles">
        <div className="row">
          <Input mono placeholder="their address 0x…" value={lookupAddr} onChange={(e) => setLookupAddr(e.target.value.trim())} />
          <Button variant="ghost" disabled={!isAddress(lookupAddr)} onClick={doLookup}>Check</Button>
        </div>
        {lookupErr && <Notice tone="err">{lookupErr}</Notice>}
        {lookup && (
          <div style={{ marginTop: 14 }}>
            <KV rows={[["Digital ID", <Badge tone={lookup.verified ? "ok" : "err"}>{lookup.verified ? "active" : "none, or suspended"}</Badge>]]} />
            <div style={{ marginTop: 10 }}><RolesTable rows={lookup.rows} /></div>
          </div>
        )}
      </Card>

      <Card title="How roles work here">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, color: "var(--muted)" }}>
          <li><b style={{ color: "var(--text)" }}>No ID, no role.</b> A role can only be given to someone with an active Digital ID.</li>
          <li><b style={{ color: "var(--text)" }}>Suspend the ID and every role stops instantly</b> — no need to remove them one by one.</li>
          <li><b style={{ color: "var(--text)" }}>Roles can expire.</b> An expired role is treated as if it were never there, though it stays visible in the history.</li>
          <li><b style={{ color: "var(--text)" }}>Admins are not exempt.</b> An admin whose ID is suspended loses admin powers too.</li>
          <li><b style={{ color: "var(--text)" }}>The User role normally comes from onboarding</b> — granted by the contract itself once the department head and an admin have both approved. Admins can still give it directly here for exceptional cases; the history shows which path was used.</li>
          <li>
            Chain of authority: <RoleChip role={ROLES.DEFAULT_ADMIN} /> → <RoleChip role={ROLES.ADMIN} /> →{" "}
            <RoleChip role={ROLES.ISSUER} /> <RoleChip role={ROLES.AUDITOR} /> <RoleChip role={ROLES.HOD} /> <RoleChip role={ROLES.USER} />
          </li>
        </ul>
      </Card>
    </div>
  );
}
