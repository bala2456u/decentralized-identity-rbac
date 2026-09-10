import { useEffect, useState } from "react";
import { ROLES, ROLE_INFO, STATUS } from "../lib/contracts";
import { DEV_ACCOUNTS } from "../lib/useWeb3";
import { Badge, Button, Card, RoleChip } from "../lib/ui";

const DEMO_ROLES = [
  [ROLES.DEFAULT_ADMIN, ROLES.ADMIN],
  [ROLES.ISSUER],
  [ROLES.AUDITOR],
  [ROLES.USER],
  [ROLES.USER],
  [ROLES.USER],
  [],
  [ROLES.HOD],
];

export default function HomePanel({ web3, me, setTab, refreshKey }) {
  const { contracts, account, isLocalChain, useDevAccount, devIndex } = web3;
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!contracts || !account) {
      setStats(null);
      return undefined;
    }
    (async () => {
      const [assetIds, history, status] = await Promise.all([
        contracts.nft.assetsOf(account),
        contracts.audit.entriesByActor(account),
        contracts.onboarding ? contracts.onboarding.statusOf(account) : Promise.resolve(0n),
      ]);
      let shared = 0;
      for (const id of assetIds) {
        const [active] = await contracts.policy.activeGranteesOf(id);
        shared += active.length;
      }
      if (!cancelled) setStats({ assets: assetIds.length, shared, history: history.length, status: Number(status) });
    })().catch(() => !cancelled && setStats(null));
    return () => {
      cancelled = true;
    };
  }, [contracts, account, refreshKey]);

  const st = stats?.status ?? STATUS.NONE;
  const hasUser = Boolean(me?.roles.includes(ROLES.USER));
  const steps = [
    {
      title: "Create your Digital ID",
      who: "you do this yourself",
      why: "This is you, in the system. Nobody — not even an admin — can create it for you, and it can never be moved to another account.",
      done: Boolean(me?.verified),
      tab: "identity",
      cta: "Create my ID",
    },
    {
      title: "Submit your details for onboarding",
      who: "you do this",
      why: "Your Staff ID, name and department. From now on everyone sees “Dave Kumar · STAFF-1042”, never a hash. The rest of your form is only fingerprinted.",
      done: st === STATUS.PENDING_HOD || st === STATUS.PENDING_ADMIN || st === STATUS.APPROVED,
      tab: "onboarding",
      cta: "Apply",
    },
    {
      title: "Your Head of Department approves",
      who: "the department head does this",
      why: "Only the head of your department can do this, and they can't approve their own request. An admin can't jump ahead of them — the contract refuses.",
      done: st === STATUS.PENDING_ADMIN || st === STATUS.APPROVED,
      tab: "onboarding",
      cta: "See status",
    },
    {
      title: "An admin gives final approval",
      who: "an admin does this",
      why: "The moment they approve, the contract itself grants you the User role. No separate step, no chance to forget.",
      done: st === STATUS.APPROVED || hasUser,
      tab: "onboarding",
      cta: "See status",
    },
    {
      title: "Receive your first asset",
      who: "an issuer does this",
      why: "A contract, a design, a licence — each becomes a unique token with a permanent record of who has held it. Only onboarded people can hold one.",
      done: Boolean(stats && stats.assets > 0),
      tab: "assets",
      cta: "See assets",
    },
    {
      title: "Share it with a colleague — or pass it on",
      who: "you do this",
      why: "Give someone View or Edit access, with an expiry date if you like. If the asset changes hands, every share is cancelled automatically.",
      done: Boolean(stats && stats.shared > 0),
      tab: "access",
      cta: "Share access",
    },
    {
      title: "Look at the history",
      who: "anyone can",
      why: "Every step above is written to a log that can't be edited or trimmed. If it's in the log, it happened. If it isn't, it didn't.",
      done: Boolean(stats && stats.history > 0),
      tab: "audit",
      cta: "Open history",
    },
  ];
  const nextIndex = steps.findIndex((s) => !s.done);

  const tryAs = (index, label) => (
    <Button size="sm" variant={devIndex === index ? "primary" : "ghost"} onClick={() => useDevAccount(index)}>{label}</Button>
  );

  return (
    <div className="stack">
      <section className="hero">
        <h2>Identity, onboarding, ownership and access — without trusting a single admin</h2>
        <p>
          Organisations juggle people, permissions and digital assets across many systems, and one compromised admin can
          quietly rewrite who owns what. Here, the rules live in code that no single person controls — including the
          order in which a new person gets approved.
        </p>
        <div className="ideas">
          <div className="idea">
            <div className="icon">🪪</div>
            <b>Everyone gets a Digital ID they control</b>
            <span>Like a passport you issue to yourself, with a readable Staff ID attached. The organisation can suspend it, never forge it.</span>
          </div>
          <div className="idea">
            <div className="icon">✅</div>
            <b>Onboarding is approved in order, by contract</b>
            <span>Staff submit → Head of Department approves → Admin approves. Stages can't be skipped, and nobody approves themselves.</span>
          </div>
          <div className="idea">
            <div className="icon">📦</div>
            <b>Assets are tokens tied to IDs</b>
            <span>A document or licence can only be held by someone who has been onboarded. Transfers to anyone else simply fail.</span>
          </div>
          <div className="idea">
            <div className="icon">🔗</div>
            <b>Nothing can be quietly changed</b>
            <span>Every action is chained to the one before it. Anyone can verify the whole history in one click.</span>
          </div>
        </div>
      </section>

      <div className="grid">
        <Card
          className="span-2"
          tone="accent"
          title="Example: Dave's first day"
          subtitle="Follow one new employee from “no account” to “owns and shares a document”. The system won't let anyone skip a step or approve out of turn."
        >
          <div className="story" style={{ marginBottom: 16 }}>
            <div className="avatar">🧑‍💼</div>
            <div>
              <b>Dave joined Procurement this morning.</b>
              <p style={{ margin: "4px 0 0", color: "var(--muted)" }}>
                By Friday he needs the supplier contract in his name and his manager needs to be able to read it. Seven
                things have to happen, in order. {account ? "The ticks below show where the currently selected person is." : "Pick a person above to see live progress."}
              </p>
            </div>
          </div>

          <ol className="steps">
            {steps.map((s, i) => (
              <li key={s.title} className={`step ${s.done ? "done" : ""} ${i === nextIndex ? "current" : ""}`}>
                <div className="step-num">{s.done ? "✓" : i + 1}</div>
                <div>
                  <b>{s.title}</b>
                  <span className="who">· {s.who}</span>
                  <p>{s.why}</p>
                </div>
                <div className="side">
                  {s.done ? <Badge tone="ok">done</Badge> : i === nextIndex ? <Badge tone="accent">next</Badge> : <Badge>not yet</Badge>}
                  <Button size="sm" variant={i === nextIndex ? "primary" : "ghost"} onClick={() => setTab(s.tab)}>
                    {s.cta} →
                  </Button>
                </div>
              </li>
            ))}
          </ol>

          {isLocalChain && (
            <div className="actions" style={{ marginTop: 16 }}>
              <span style={{ color: "var(--muted)", fontSize: 13 }}>Try it now:</span>
              {tryAs(6, "Act as Dave")}
              {tryAs(7, "Act as the Head of Dept")}
              {tryAs(0, "Act as the admin")}
              {tryAs(1, "Act as the issuer")}
              <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
                Steps 1–2 are Dave's, 3 the department head's, 4 the admin's, 5 the issuer's, then Dave again.
              </span>
            </div>
          )}
        </Card>

        <Card title="What each role can do">
          <div className="legend">
            {Object.entries(ROLE_INFO).map(([role, info]) => (
              <div key={role}>
                <RoleChip role={role} />
                <span>{info.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        {isLocalChain ? (
          <Card title="Who's who in the demo" subtitle="Ready-made people on the local test network. Switch between them with “Try as” in the header.">
            <div className="legend">
              {DEV_ACCOUNTS.map((a, i) => (
                <div key={a.label}>
                  <Button size="sm" variant={devIndex === i ? "primary" : "ghost"} onClick={() => useDevAccount(i)}>
                    {a.label.split("—")[0].trim()}
                  </Button>
                  <span>{DEMO_ROLES[i]?.length ? DEMO_ROLES[i].map((r) => ROLE_INFO[r].label).join(" + ") : "no ID yet — start from step 1"}</span>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card title="Getting started on this network">
            <p style={{ margin: 0, color: "var(--muted)" }}>
              Sign in with your wallet, then start at step 1. Your department head and an admin of this deployment will
              need to approve your onboarding before you can hold assets.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
