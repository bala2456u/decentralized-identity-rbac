import { useCallback, useEffect, useReducer, useState } from "react";
import { useWeb3, DEV_ACCOUNTS } from "./lib/useWeb3";
import { CHAIN_NAMES, ROLES } from "./lib/contracts";
import { parseVerifyHash, verifyHash } from "./lib/docs";
import { NamesProvider } from "./lib/names";
import { Addr, Badge, Button, Notice, RoleChip } from "./lib/ui";

import HomePanel from "./panels/HomePanel";
import IdentityPanel from "./panels/IdentityPanel";
import OnboardingPanel from "./panels/OnboardingPanel";
import RolesPanel from "./panels/RolesPanel";
import AssetsPanel from "./panels/AssetsPanel";
import AccessPanel from "./panels/AccessPanel";
import AuditPanel from "./panels/AuditPanel";
import VerifyPanel from "./panels/VerifyPanel";

const TABS = [
  ["home", "Start here"],
  ["identity", "My Digital ID"],
  ["onboarding", "Onboarding"],
  ["roles", "Roles"],
  ["assets", "Assets"],
  ["access", "Sharing"],
  ["audit", "History"],
  ["verify", "Verify"],
];

const PANELS = {
  home: HomePanel,
  identity: IdentityPanel,
  onboarding: OnboardingPanel,
  roles: RolesPanel,
  assets: AssetsPanel,
  access: AccessPanel,
  audit: AuditPanel,
  verify: VerifyPanel,
};

export default function App() {
  const web3 = useWeb3();
  const { account, chainId, deployment, contracts, connect, hasWallet, error, useDevAccount, devIndex, isLocalChain } = web3;

  const [verifyTarget, setVerifyTarget] = useState(() => parseVerifyHash());
  const [tab, setTab] = useState(() => (parseVerifyHash() ? "verify" : "home"));
  const [refreshKey, refresh] = useReducer((x) => x + 1, 0);
  const [me, setMe] = useState(null);

  // Shareable links: <site>/#verify=asset:1 opens the Verify tab on that record.
  useEffect(() => {
    const onHash = () => {
      const t = parseVerifyHash();
      if (t) {
        setVerifyTarget(t);
        setTab("verify");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openVerify = useCallback((kind, id) => {
    const target = { kind, id: String(id) };
    window.history.replaceState(null, "", verifyHash(kind, target.id));
    setVerifyTarget(target);
    setTab("verify");
  }, []);

  // Who am I, according to the chain?
  useEffect(() => {
    let cancelled = false;
    if (!contracts || !account) {
      setMe(null);
      return undefined;
    }
    (async () => {
      const [verified, did, r] = await Promise.all([
        contracts.did.isVerified(account),
        contracts.did.didOf(account),
        contracts.roles.rolesOf(account),
      ]);
      const roles = [];
      if (r.isRootAdmin) roles.push(ROLES.DEFAULT_ADMIN);
      if (r.isAdmin) roles.push(ROLES.ADMIN);
      if (r.isIssuer) roles.push(ROLES.ISSUER);
      if (r.isAuditor) roles.push(ROLES.AUDITOR);
      if (r.isHod) roles.push(ROLES.HOD);
      if (r.isUser) roles.push(ROLES.USER);
      if (!cancelled) {
        setMe({ verified, did, roles, isAdmin: r.isAdmin || r.isRootAdmin, isIssuer: r.isIssuer, isHod: r.isHod, isUser: r.isUser });
      }
    })().catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, [contracts, account, refreshKey]);

  const Panel = PANELS[tab];
  const panelProps = { web3, me, refresh, refreshKey, setTab, openVerify, verifyTarget };

  return (
    <NamesProvider contracts={contracts} refreshKey={refreshKey}>
      <div className="app">
        <header className="header">
          <div className="brand">
            <div className="brand-mark">ID</div>
            <div>
              <h1>Decentralized Identity &amp; Asset Control</h1>
              <p>Digital IDs · approved onboarding · who owns what · who can see what · documents that verify themselves</p>
            </div>
          </div>

          <div className="wallet">
            {chainId && <Badge tone="accent">{CHAIN_NAMES[chainId] ?? `network ${chainId}`}</Badge>}

            {isLocalChain && (
              <label className="row" style={{ gap: 6 }}>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>Try as</span>
                <select
                  className="input"
                  style={{ width: "auto", padding: "6px 8px" }}
                  value={devIndex}
                  onChange={(e) => useDevAccount(Number(e.target.value))}
                  title="Demo accounts for the local test network — no wallet needed"
                >
                  <option value={-1}>choose a person…</option>
                  {DEV_ACCOUNTS.map((a, i) => (
                    <option key={i} value={i}>{a.label}</option>
                  ))}
                </select>
              </label>
            )}

            {account ? (
              <div className="who">
                <Badge tone={me?.verified ? "ok" : "warn"}>{me?.verified ? "ID active" : "no ID yet"}</Badge>
                {me?.roles.map((r) => <RoleChip key={r} role={r} />)}
                <Addr value={account} />
              </div>
            ) : (
              <Button onClick={connect}>{hasWallet ? "Sign in with wallet" : "Browse (read-only)"}</Button>
            )}
          </div>
        </header>

        {error && <Notice tone="err">{error}</Notice>}
        {chainId && !deployment && (
          <Notice tone="warn">
            The app isn't set up on this network yet. Run <code>npm run deploy:local</code>, or switch your wallet to a
            network listed in <code>frontend/src/deployments.json</code>.
          </Notice>
        )}
        {deployment && !deployment.contracts.DocumentStore && (
          <Notice tone="warn">
            This deployment predates the document store. Redeploy with <code>npm run deploy:local</code> and <code>npm run seed:local</code>.
          </Notice>
        )}
        {!account && contracts && tab !== "verify" && (
          <Notice tone="info">
            You're browsing. To take an action, {isLocalChain ? "pick a person from “Try as” above" : "sign in with a wallet"}.
            The <b>Verify</b> tab works without signing in.
          </Notice>
        )}

        <nav className="tabs">
          {TABS.map(([key, label], i) => (
            <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              <span className="num">{i === 0 ? "★" : key === "verify" ? "✓" : i}</span>
              {label}
            </button>
          ))}
        </nav>

        <main>
          {contracts ? <Panel {...panelProps} /> : <div className="empty">Waiting for a network with the app deployed…</div>}
        </main>

        <footer>
          Every rule you see enforced here is enforced by the smart contracts themselves — this screen only shows what the chain allows.
          {deployment && (
            <div>
              Contracts:{" "}
              {Object.entries(deployment.contracts).map(([n, a]) => (
                <span key={n}> {n} <span className="mono" title={a}>{a.slice(0, 8)}…</span> </span>
              ))}
            </div>
          )}
        </footer>
      </div>
    </NamesProvider>
  );
}
