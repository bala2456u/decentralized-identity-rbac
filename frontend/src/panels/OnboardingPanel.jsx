import { useEffect, useState } from "react";
import { isAddress } from "ethers";
import { DEPARTMENTS, describeError, fmtTime, hashText, isZero, STATUS, STATUS_LABEL } from "../lib/contracts";
import { Addr, Badge, Button, Card, Empty, Explain, Field, Input, KV, Notice, Table, useTx } from "../lib/ui";

export default function OnboardingPanel(props) {
  const { web3 } = props;
  if (!web3.contracts?.onboarding) {
    return <Notice tone="warn">This deployment has no Onboarding contract. Redeploy and reseed.</Notice>;
  }
  return (
    <div className="grid">
      <MyRequest {...props} />
      <Approvals {...props} />
      <FindByStaffId {...props} />
      {props.me?.isAdmin && <DepartmentHeads {...props} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The applicant's own request
// ---------------------------------------------------------------------------

function MyRequest({ web3, me, refresh, refreshKey, setTab }) {
  const { contracts, account } = web3;
  const [req, setReq] = useState(null);
  const [form, setForm] = useState({ staffId: "", name: "", department: DEPARTMENTS[0], details: "" });
  const tx = useTx(refresh);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    if (!contracts || !account) return;
    contracts.onboarding.getRequest(account).then(setReq).catch(() => setReq(null));
  }, [contracts, account, refreshKey]);

  if (!account) {
    return (
      <Card title="My onboarding">
        <Empty>Pick a person (or sign in) to start or follow an onboarding request.</Empty>
      </Card>
    );
  }
  if (!me?.verified) {
    return (
      <Card title="My onboarding" tone="accent">
        <Notice tone="warn">Step 1 first: you need a Digital ID before you can apply for onboarding.</Notice>
        <div className="actions"><Button onClick={() => setTab("identity")}>Create my Digital ID →</Button></div>
      </Card>
    );
  }
  if (!req) return <Card title="My onboarding"><Empty>Loading…</Empty></Card>;

  const status = Number(req.status);

  if (status === STATUS.NONE || status === STATUS.REJECTED) {
    return (
      <Card
        tone="accent"
        title={status === STATUS.REJECTED ? "Fix and resubmit your onboarding" : "Apply for onboarding"}
        subtitle="Enter your details once. Your Head of Department checks them, then an admin gives final approval. The User role is granted automatically at the end."
      >
        {status === STATUS.REJECTED && (
          <Notice tone="err">
            Your previous request was rejected by <Addr value={req.rejectedBy} />: <i>“{req.rejectReason}”</i>
          </Notice>
        )}
        <Explain title="What happens to my details?">
          Your Staff ID, name and department are recorded on the chain so colleagues see <b>you</b>, not a hash. Anything
          else you type in "Other details" stays with you — only its fingerprint is recorded, so it can be proven later
          without being exposed.
        </Explain>
        <div className="row">
          <Field label="Staff ID" hint="Your organisation's reference for you. Must be unique."><Input placeholder="e.g. STAFF-1042" value={form.staffId} onChange={f("staffId")} /></Field>
          <Field label="Full name"><Input placeholder="e.g. Dave Kumar" value={form.name} onChange={f("name")} /></Field>
        </div>
        <Field label="Department" hint="Your request goes to the head of this department first.">
          <Input list="departments" value={form.department} onChange={f("department")} />
          <datalist id="departments">{DEPARTMENTS.map((d) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label="Other details (fingerprinted, not stored)" hint={form.details ? `Fingerprint: ${hashText(form.details)}` : "e.g. joining date, manager, contract reference"}>
          <textarea className="input" rows={3} value={form.details} onChange={f("details")} />
        </Field>
        <div className="actions">
          <Button busy={tx.busy} disabled={!form.staffId || !form.department}
            onClick={() => tx.run("Submit onboarding request", () =>
              contracts.onboarding.submit(form.staffId.trim(), form.name.trim(), form.department.trim(), hashText(form.details || `${form.staffId}:${account}`)))}>
            Submit for approval
          </Button>
        </div>
        <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
      </Card>
    );
  }

  const stage = (done, current) => (done ? "done" : current ? "current" : "");
  return (
    <Card
      title="My onboarding"
      subtitle="Each stage is enforced by the contract — nobody can skip one."
      right={<Badge tone={status === STATUS.APPROVED ? "ok" : "accent"}>{STATUS_LABEL[status]}</Badge>}
    >
      <KV rows={[["Staff ID", <b>{req.staffId}</b>], ["Name", req.displayName || "—"], ["Department", req.department]]} />
      <ol className="timeline" style={{ marginTop: 16 }}>
        <li className="done">
          <div className="dot">✓</div>
          <div><b>Submitted</b><div className="meta">{fmtTime(req.submittedAt)}</div></div>
        </li>
        <li className={stage(status >= STATUS.PENDING_ADMIN, status === STATUS.PENDING_HOD)}>
          <div className="dot">{status >= STATUS.PENDING_ADMIN ? "✓" : "2"}</div>
          <div>
            <b>Head of {req.department} approves</b>
            <div className="meta">
              {status >= STATUS.PENDING_ADMIN
                ? isZero(req.hodApprover)
                  ? "not required — profile recorded directly by an admin"
                  : <>by <Addr value={req.hodApprover} /> · {fmtTime(req.hodApprovedAt)}</>
                : "waiting…"}
            </div>
          </div>
        </li>
        <li className={stage(status === STATUS.APPROVED, status === STATUS.PENDING_ADMIN)}>
          <div className="dot">{status === STATUS.APPROVED ? "✓" : "3"}</div>
          <div>
            <b>Admin gives final approval</b>
            <div className="meta">
              {status === STATUS.APPROVED ? <>by <Addr value={req.adminApprover} /> · {fmtTime(req.adminApprovedAt)}</> : status === STATUS.PENDING_ADMIN ? "waiting…" : "after the department head"}
            </div>
          </div>
        </li>
        <li className={status === STATUS.APPROVED ? "done" : ""}>
          <div className="dot">{status === STATUS.APPROVED ? "✓" : "4"}</div>
          <div>
            <b>User role granted — you can now own and receive assets</b>
            <div className="meta">{status === STATUS.APPROVED ? "granted automatically by the contract" : "happens automatically at final approval"}</div>
          </div>
        </li>
      </ol>
      {status === STATUS.APPROVED && (
        <div className="actions"><Button size="sm" variant="ghost" onClick={() => setTab("assets")}>See my assets →</Button></div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approval queues for Heads of Department and admins
// ---------------------------------------------------------------------------

function Approvals({ web3, me, refresh, refreshKey }) {
  const { contracts, account } = web3;
  const [hodQueue, setHodQueue] = useState([]);
  const [adminQueue, setAdminQueue] = useState([]);
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts || !account) return;
    (async () => {
      const load = async (stage) => {
        const addrs = await contracts.onboarding.pendingAt(stage);
        return Promise.all(addrs.map(async (a) => ({ address: a, req: await contracts.onboarding.getRequest(a) })));
      };
      const [hodAll, adminAll] = await Promise.all([load(STATUS.PENDING_HOD), load(STATUS.PENDING_ADMIN)]);
      // only requests from departments this person heads
      const mine = [];
      for (const item of hodAll) {
        const head = await contracts.onboarding.departmentHead(item.req.department);
        if (head.toLowerCase() === account.toLowerCase()) mine.push(item);
      }
      setHodQueue(mine);
      setAdminQueue(adminAll);
    })().catch(() => { setHodQueue([]); setAdminQueue([]); });
  }, [contracts, account, refreshKey]);

  const rejectWithReason = (applicant) => {
    const reason = window.prompt("Reason for rejection (kept on record):", "");
    if (reason === null) return;
    tx.run("Reject request", () => contracts.onboarding.reject(applicant, reason || "no reason given"));
  };

  const queueTable = (rows, approveLabel, approveFn) => (
    <Table
      head={["Applicant", "Staff ID", "Department", "Submitted", ""]}
      empty="Nothing waiting for you."
      rows={rows.map(({ address, req }) => [
        <span><b>{req.displayName || "—"}</b> <span style={{ color: "var(--muted)" }}>(<Addr value={address} />)</span></span>,
        req.staffId,
        req.department,
        fmtTime(req.submittedAt),
        <span className="row">
          <Button size="sm" busy={tx.busy} onClick={() => tx.run(approveLabel, () => approveFn(address))}>Approve</Button>
          <Button size="sm" variant="danger" busy={tx.busy} onClick={() => rejectWithReason(address)}>Reject</Button>
        </span>,
      ])}
    />
  );

  if (!me?.isHod && !me?.isAdmin) {
    return (
      <Card title="Approvals" subtitle="Requests waiting for a decision.">
        <Empty>Approval queues appear here for Heads of Department and admins.</Empty>
      </Card>
    );
  }

  return (
    <Card title="Approvals waiting for you" subtitle="Stage one goes to the department head, stage two to an admin. The contract refuses anything out of order.">
      {me?.isHod && (
        <>
          <h4>Stage 1 — as Head of Department <Badge tone="accent">{hodQueue.length}</Badge></h4>
          {queueTable(hodQueue, "Approve as Head of Department", (a) => contracts.onboarding.approveByHOD(a))}
        </>
      )}
      {me?.isAdmin && (
        <>
          <h4 style={{ marginTop: me?.isHod ? 18 : 0 }}>Stage 2 — final admin approval <Badge tone="accent">{adminQueue.length}</Badge></h4>
          {queueTable(adminQueue, "Give final approval", (a) => contracts.onboarding.approveByAdmin(a))}
          <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "8px 0 0" }}>
            Approving here grants the User role automatically. The history will show you as the approver.
          </p>
        </>
      )}
      <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Look someone up by Staff ID
// ---------------------------------------------------------------------------

function FindByStaffId({ web3 }) {
  const { contracts } = web3;
  const [staffId, setStaffId] = useState("");
  const [result, setResult] = useState(null);

  const find = async () => {
    try {
      const address = await contracts.onboarding.resolveStaffId(staffId.trim());
      if (isZero(address)) return setResult({ none: true });
      const [req, did, verified] = await Promise.all([
        contracts.onboarding.getRequest(address),
        contracts.did.didOf(address),
        contracts.did.isVerified(address),
      ]);
      setResult({ address, req, did, verified });
    } catch (e) {
      setResult({ error: describeError(e).friendly });
    }
  };

  return (
    <Card title="Find a person by Staff ID" subtitle="Every Digital ID has a readable reference, so you never have to work with a hash.">
      <div className="row">
        <Input placeholder="e.g. STAFF-1001" value={staffId} onChange={(e) => setStaffId(e.target.value)} style={{ maxWidth: 240 }} />
        <Button variant="ghost" disabled={!staffId.trim()} onClick={find}>Find</Button>
      </div>
      {result?.none && <Notice tone="warn">No one has that Staff ID.</Notice>}
      {result?.error && <Notice tone="err">{result.error}</Notice>}
      {result?.req && (
        <div style={{ marginTop: 14 }}>
          <KV
            rows={[
              ["Name", <b>{result.req.displayName || "—"}</b>],
              ["Department", result.req.department],
              ["Onboarding", <Badge tone={Number(result.req.status) === STATUS.APPROVED ? "ok" : "accent"}>{STATUS_LABEL[Number(result.req.status)]}</Badge>],
              ["Digital ID", <Badge tone={result.verified ? "ok" : "err"}>{result.verified ? "active" : "suspended"}</Badge>],
              ["Address", <Addr value={result.address} full />],
              ["ID", <code>{result.did}</code>],
            ]}
          />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Admin: who heads which department
// ---------------------------------------------------------------------------

function DepartmentHeads({ web3, refresh, refreshKey }) {
  const { contracts } = web3;
  const [heads, setHeads] = useState([]);
  const [form, setForm] = useState({ department: DEPARTMENTS[0], head: "" });
  const tx = useTx(refresh);

  useEffect(() => {
    if (!contracts) return;
    Promise.all(DEPARTMENTS.map(async (d) => [d, await contracts.onboarding.departmentHead(d)]))
      .then(setHeads)
      .catch(() => setHeads([]));
  }, [contracts, refreshKey]);

  return (
    <Card title="Department heads" subtitle="Admin only. A head must already hold the Head of Dept role; give it under Roles first.">
      <Table
        head={["Department", "Head"]}
        rows={heads.map(([d, h]) => [d, isZero(h) ? <span className="empty">nobody yet</span> : <Addr value={h} />])}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="Department">
          <Input list="departments2" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          <datalist id="departments2">{DEPARTMENTS.map((d) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label="Head (address)"><Input mono placeholder="0x…" value={form.head} onChange={(e) => setForm({ ...form, head: e.target.value.trim() })} /></Field>
      </div>
      <div className="actions">
        <Button busy={tx.busy} disabled={!form.department || !isAddress(form.head)}
          onClick={() => tx.run(`Appoint head of ${form.department}`, () => contracts.onboarding.setDepartmentHead(form.department.trim(), form.head))}>
          Appoint
        </Button>
      </div>
      <Notice tone={tx.tone} detail={tx.detail}>{tx.msg}</Notice>
    </Card>
  );
}
