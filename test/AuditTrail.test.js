const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, mintTo, ACTIONS } = require("./helpers/fixture");

describe("AuditTrail", function () {
  it("only registered writer contracts can append", async function () {
    const { audit, admin, alice } = await loadFixture(deploySystem);
    await expect(audit.connect(alice).record(ethers.id("X"), alice.address, alice.address, 0, ethers.ZeroHash))
      .to.be.revertedWithCustomError(audit, "NotWriter")
      .withArgs(alice.address);
    // not even the admin can write directly — it must go through a system contract
    await expect(audit.connect(admin).record(ethers.id("X"), admin.address, admin.address, 0, ethers.ZeroHash))
      .to.be.revertedWithCustomError(audit, "NotWriter");
  });

  it("only the admin can manage writers", async function () {
    const { audit, alice } = await loadFixture(deploySystem);
    await expect(audit.connect(alice).setWriter(alice.address, true))
      .to.be.revertedWithCustomError(audit, "NotAdmin");
  });

  it("the fixture's setup activity is already recorded in order", async function () {
    const { audit, issuer, alice } = await loadFixture(deploySystem);
    const total = await audit.totalEntries();
    expect(total).to.be.greaterThan(0n);

    const first = await audit.entryAt(0);
    expect(first.action).to.equal(ACTIONS.DID_REGISTERED);
    expect(first.actor).to.equal(issuer.address);
    expect(first.prevHash).to.equal(ethers.ZeroHash);

    const byAlice = await audit.entriesByActor(alice.address);
    expect(byAlice.length).to.equal(1); // her registration
    const aboutAlice = await audit.entriesBySubject(alice.address);
    expect(aboutAlice.length).to.equal(1); // her USER_ROLE grant (actor = admin)
  });

  it("forms an unbroken hash chain whose head is the last entry", async function () {
    const { audit, nft, issuer, alice, bob } = await loadFixture(deploySystem);
    const { tokenId } = await mintTo(nft, issuer, alice);
    await nft.connect(alice).transferFrom(alice.address, bob.address, tokenId);

    const total = await audit.totalEntries();
    const [ok, brokenAt] = await audit.verifyChain(0, total - 1n);
    expect(ok).to.equal(true);
    expect(brokenAt).to.equal(0);

    const last = await audit.entryAt(total - 1n);
    expect(await audit.head()).to.equal(last.entryHash);

    // each entry's prevHash is exactly the previous entry's entryHash
    for (let i = 1n; i < total; i++) {
      const prev = await audit.entryAt(i - 1n);
      const cur = await audit.entryAt(i);
      expect(cur.prevHash).to.equal(prev.entryHash);
    }
  });

  it("verifyChain rejects out-of-range requests", async function () {
    const { audit } = await loadFixture(deploySystem);
    const total = await audit.totalEntries();
    await expect(audit.verifyChain(0, total)).to.be.revertedWithCustomError(audit, "RangeOutOfBounds");
    await expect(audit.verifyChain(3, 2)).to.be.revertedWithCustomError(audit, "RangeOutOfBounds");
  });

  it("pages through the log and clamps at the end", async function () {
    const { audit } = await loadFixture(deploySystem);
    const total = Number(await audit.totalEntries());

    const page = await audit.getRange(0, 3);
    expect(page.length).to.equal(3);

    const tail = await audit.getRange(total - 2, 100);
    expect(tail.length).to.equal(2);

    const empty = await audit.getRange(total, 10);
    expect(empty.length).to.equal(0);
  });
});
