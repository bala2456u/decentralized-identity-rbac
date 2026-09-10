/**
 * Lets the person decide where a document lives. The chain always records the
 * fingerprint; the question is whether the bytes themselves go on the ledger too.
 */
export default function StorageChoice({ value, onChange, what = "document" }) {
  return (
    <div className="choice">
      <label className={value === "ledger" ? "on" : ""}>
        <input type="radio" checked={value === "ledger"} onChange={() => onChange("ledger")} />
        <div>
          <b>Store the {what} on the ledger</b>
          <span>
            Public and permanent — anyone can open it and verify it, and the link can never go dead. Nothing personal
            should be inside. Best for ID documents, certificates and published contracts.
          </span>
        </div>
      </label>
      <label className={value === "link" ? "on" : ""}>
        <input type="radio" checked={value === "link"} onChange={() => onChange("link")} />
        <div>
          <b>Keep it somewhere else — I'll give a link</b>
          <span>Only the fingerprint is recorded on the chain. Best for private or large files (IPFS, a document server…).</span>
        </div>
      </label>
    </div>
  );
}
