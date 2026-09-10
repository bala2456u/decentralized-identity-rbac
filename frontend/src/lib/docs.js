import { keccak256, toUtf8Bytes, toUtf8String } from "ethers";

/**
 * Documents referenced from the chain come in three flavours:
 *   ledger://<hash>  – stored in our DocumentStore contract; the hash IS the fingerprint
 *   ipfs://<cid>     – on IPFS; opened through a public gateway
 *   https://…        – anywhere else
 * Whatever the flavour, the chain only ever trusts the fingerprint next to it.
 */
export const LEDGER_PREFIX = "ledger://";
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export function parseLink(uri) {
  if (!uri) return { kind: "none" };
  if (uri.startsWith(LEDGER_PREFIX)) return { kind: "ledger", hash: uri.slice(LEDGER_PREFIX.length) };
  if (uri.startsWith("ipfs://")) return { kind: "ipfs", cid: uri.slice(7), url: IPFS_GATEWAY + uri.slice(7) };
  if (/^https?:\/\//i.test(uri)) return { kind: "http", url: uri };
  return { kind: "other" };
}

export const hashDoc = (text) => keccak256(toUtf8Bytes(text));
export const ledgerLink = (hash) => LEDGER_PREFIX + hash;

/** Read a document back from the ledger and recompute its fingerprint. */
export async function fetchLedgerDoc(contracts, hash) {
  if (!contracts?.docs) throw new Error("This network has no document store.");
  const bytes = await contracts.docs.get(hash);
  if (!bytes || bytes === "0x") return null;
  const meta = await contracts.docs.metaOf(hash);
  let text = null;
  try {
    text = toUtf8String(bytes);
  } catch {
    /* binary content: shown as bytes */
  }
  return {
    hash,
    bytes,
    text,
    computed: keccak256(bytes),
    storedBy: meta.storedBy,
    storedAt: meta.storedAt,
    size: Number(meta.size),
  };
}

/** Store a text document on the ledger (no-op if already there). Returns its link + fingerprint. */
export async function storeDoc(contracts, text) {
  if (!contracts?.docs) throw new Error("This network has no document store.");
  const bytes = toUtf8Bytes(text);
  const hash = keccak256(bytes);
  if (!(await contracts.docs.exists(hash))) {
    const tx = await contracts.docs.store(bytes);
    await tx.wait();
  }
  return { hash, link: ledgerLink(hash) };
}

// ---------------------------------------------------------------------------
// Shareable verify links:  <site>/#verify=asset:1
// ---------------------------------------------------------------------------

export const VERIFY_KINDS = ["identity", "asset", "certificate", "staff"];

export const verifyHash = (kind, id) => `#verify=${kind}:${encodeURIComponent(id)}`;
export const verifyUrl = (kind, id) => `${window.location.origin}${window.location.pathname}${verifyHash(kind, id)}`;

export function parseVerifyHash(hash = window.location.hash) {
  const m = /^#verify=(identity|asset|certificate|staff):(.+)$/.exec(hash);
  return m ? { kind: m[1], id: decodeURIComponent(m[2]) } : null;
}
