const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, registerDID } = require("./helpers/fixture");

const DOC = JSON.stringify({ id: "did:yhack:31337:dave", publicKey: "0xabc", service: "https://example.org" });
const BYTES = ethers.toUtf8Bytes(DOC);
const HASH = ethers.keccak256(BYTES);

describe("DocumentStore", function () {
  it("stores a document under its own keccak256 hash and returns it byte-for-byte", async function () {
    const { docs, alice } = await loadFixture(deploySystem);

    await expect(docs.connect(alice).store(BYTES))
      .to.emit(docs, "DocumentStored")
      .withArgs(HASH, alice.address, BYTES.length);

    expect(await docs.exists(HASH)).to.equal(true);
    expect(ethers.toUtf8String(await docs.get(HASH))).to.equal(DOC);
    expect(ethers.keccak256(await docs.get(HASH))).to.equal(HASH);

    const meta = await docs.metaOf(HASH);
    expect(meta.storedBy).to.equal(alice.address);
    expect(meta.size).to.equal(BYTES.length);
    expect(await docs.totalDocuments()).to.equal(1);
  });

  it("is idempotent: re-storing identical content keeps the original record", async function () {
    const { docs, alice, bob } = await loadFixture(deploySystem);
    await docs.connect(alice).store(BYTES);
    await expect(docs.connect(bob).store(BYTES)).to.not.emit(docs, "DocumentStored");
    expect((await docs.metaOf(HASH)).storedBy).to.equal(alice.address);
    expect(await docs.totalDocuments()).to.equal(1);
  });

  it("rejects empty and oversized documents", async function () {
    const { docs, alice } = await loadFixture(deploySystem);
    await expect(docs.connect(alice).store("0x")).to.be.revertedWithCustomError(docs, "EmptyDocument");
    const big = new Uint8Array(24 * 1024 + 1).fill(65);
    await expect(docs.connect(alice).store(big))
      .to.be.revertedWithCustomError(docs, "DocumentTooLarge")
      .withArgs(big.length, 24 * 1024);
  });

  it("unknown hashes read back as empty", async function () {
    const { docs } = await loadFixture(deploySystem);
    expect(await docs.exists(ethers.id("nope"))).to.equal(false);
    expect(await docs.get(ethers.id("nope"))).to.equal("0x");
  });

  it("a DID document stored on the ledger verifies against the identity's fingerprint", async function () {
    const { docs, did, dave } = await loadFixture(deploySystem);

    // dave already has a DID in the fixture; register a fresh account to use a ledger:// document
    const [, , , , , , , , , newcomer] = await ethers.getSigners();
    await docs.connect(newcomer).store(BYTES);
    await did.connect(newcomer).register(`ledger://${HASH}`, HASH);

    const identity = await did.getIdentity(newcomer.address);
    expect(identity.docURI).to.equal(`ledger://${HASH}`);

    // a verifier fetches the bytes by the link's hash and recomputes the fingerprint
    const fetched = await docs.get(identity.docHash);
    expect(ethers.keccak256(fetched)).to.equal(identity.docHash);
    expect(ethers.toUtf8String(fetched)).to.equal(DOC);
    expect(dave.address).to.not.equal(newcomer.address);
  });
});
