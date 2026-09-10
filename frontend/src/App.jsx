import { useEffect, useReducer, useState } from "react";
import { useWeb3, DEV_ACCOUNTS } from "./lib/useWeb3";
import { CHAIN_NAMES, ROLES, ROLE_LABEL } from "./lib/contracts";
import { Addr, Badge, Button, Notice } from "./lib/ui";

import IdentityPanel from "./panels/IdentityPanel";
import RolesPanel from "./panels/RolesPanel";
import AssetsPanel from "./panels/AssetsPanel";
import AccessPanel from "./panels/AccessPanel";
import AuditPanel from "./panels/AuditPanel";

const TABS = [
  ["identity", "Identity"],
  ["roles", "Roles"],
  ["assets", "Assets"],
  ["access", "Access"],
  ["audit", "Audit"],
];

export default function App() {
  const web3 = useWeb3();
  const { account, chainId, deployment, contracts, connect, hasWallet, error, useDevAccount, devIndex, isLocalChain } = web3;

  const [tab, setTab] = useState("identity");
  const [refreshKey, refresh] = useReducer((x) => x + 1, 0);
  const [me, setMe] = useState(null);

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
      if (r.isUser) roles.push(ROLES.USER);
      if (!cancelled) setMe({ verified, did, roles, isAdmin: r.isAdmin || r.isRootAdmin, isIssuer: r.isIssuer });
    })().catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, [contracts, account, refreshKey]);

  const panelProps = { web3, me, refresh, refreshKey };
  const Panel = { identity: IdentityPanel, roles: RolesPanel, assets: AssetsPanel, access: AccessPanel, audit: AuditPanel }[tab];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-mark">ID</div>
          <div>
            <h1>Decentralized Identity &amp; Asset Control</h1>
            <p>DIDs · NFT ownership · role-based access · tamper-evident audit</p>
          </div>
        </div>

        <div className="wallet">
          {chainId && <Badge tone="accent">{CHAIN_NAMES[chainId] ?? `chain ${chainId}`}</Badge>}
          {isLocalChain && (
            <select
              className="input"
              style={{ width: "auto", padding: "6px 8px" }}
              value={devIndex}
              onChange={(e) => useDevAccount(Number(e.target.value))}
              title="Local demo accounts (Hardhat's public test keys) — no wallet needed"
            >
              <option value={-1}>Act as… (demo account)</option>
              {DEV_ACCOUNTS.map((a, i) => (
                <option key={i} value={i}>{a.label}</option>
              ))}
            </select>
          )}
          {account ? (
            <>
              <Badge tone={me?.verified ? "ok" : "warn"}>{me?.verified ? "DID active" : "no DID"}</Badge>
              {me?.roles.map((r) => (
                <Badge key={r} tone="muted">{ROLE_LABEL[r]}</Badge>
              ))}
              <Addr value={account} />
            </>
          ) : (
            <Button onClick={connect}>{hasWallet ? "Connect wallet" : "Connect (read-only)"}</Button>
          )}
        </div>
      </header>

      {error && <Notice tone="err">{error}</Notice>}
      {chainId && !deployment && (
        <Notice tone="warn">
          No deployment found for chain {chainId}. Run <code>npm run deploy:local</code> (or switch your wallet to a network
          listed in <code>frontend/src/deployments.json</code>).
        </Notice>
      )}
      {!account && contracts && (
        <Notice tone="info">Read-only mode: you can browse everything but need a connected wallet to send transactions.</Notice>
      )}

      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      <main>{contracts ? <Panel {...panelProps} /> : <div className="empty">Connect to a network with a deployment to begin.</div>}</main>

      <footer>
        Every action shown here is enforced by the smart contracts — the UI only reflects what the chain allows.
        {deployment && (
          <>
            {" "}Contracts: {Object.entries(deployment.contracts).map(([n, a]) => (
              <span key={n}> {n} <Addr value={a} /></span>
            ))}
          </>
        )}
      </footer>
    </div>
  );
}
