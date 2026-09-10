const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, mintTo, signGrant, LEVEL, ACTIONS } = require("./helpers/fixture");

async function withAsset() {
  const ctx = await deploySystem();
  const { tokenId } = await mintTo(ctx.nft, ctx.issuer, ctx.alice);
  return { ...ctx, tokenId };
}

describe("AccessPolicy", function () {
  describe("granting", function () {
    it("the owner implicitly holds MANAGE; everyone else starts at NONE", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      expect(await policy.effectiveLevel(tokenId, alice.address)).to.equal(LEVEL.MANAGE);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.NONE);
    });

    it("owner grants VIEW; hasAccess respects the level ladder", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);

      await expect(policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0))
        .to.emit(policy, "AccessGranted")
        .withArgs(tokenId, bob.address, alice.address, LEVEL.VIEW, 0);

      expect(await policy.hasAccess(tokenId, bob.address, LEVEL.VIEW)).to.equal(true);
      expect(await policy.hasAccess(tokenId, bob.address, LEVEL.EDIT)).to.equal(false);

      const [active, levels] = await policy.activeGranteesOf(tokenId);
      expect(active).to.deep.equal([bob.address]);
      expect(levels).to.deep.equal([BigInt(LEVEL.VIEW)]);
    });

    it("a non-owner cannot grant on someone else's asset", async function () {
      const { policy, tokenId, bob, carol } = await loadFixture(withAsset);
      await expect(policy.connect(carol).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToGrant")
        .withArgs(carol.address, tokenId, LEVEL.VIEW);
    });

    it("an admin can grant on any asset", async function () {
      const { policy, tokenId, admin, bob } = await loadFixture(withAsset);
      await policy.connect(admin).grantAccess(tokenId, bob.address, LEVEL.EDIT, 0);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.EDIT);
    });

    it("cannot grant to an account without a DID", async function () {
      const { policy, tokenId, alice, mallory } = await loadFixture(withAsset);
      await expect(policy.connect(alice).grantAccess(tokenId, mallory.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(policy, "IdentityNotVerified")
        .withArgs(mallory.address);
    });

    it("cannot grant to the owner, or with an invalid level, or in the past", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      await expect(policy.connect(alice).grantAccess(tokenId, alice.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(policy, "GranteeIsOwner");
      await expect(policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.NONE, 0))
        .to.be.revertedWithCustomError(policy, "InvalidLevel");
      await expect(policy.connect(alice).grantAccess(tokenId, bob.address, 4, 0))
        .to.be.revertedWithCustomError(policy, "InvalidLevel");
      const past = (await time.latest()) - 1;
      await expect(policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, past))
        .to.be.revertedWithCustomError(policy, "ExpiryInPast");
    });

    it("cannot grant on a token that does not exist", async function () {
      const { policy, nft, alice, bob } = await loadFixture(withAsset);
      await expect(policy.connect(alice).grantAccess(999, bob.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
    });
  });

  describe("expiry and revocation", function () {
    it("a time-boxed grant lapses on its own", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      const expiresAt = (await time.latest()) + 600;
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.EDIT, expiresAt);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.EDIT);
      await time.increase(601);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.NONE);
    });

    it("the owner can revoke; strangers cannot; revoking nothing reverts", async function () {
      const { policy, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0);

      await expect(policy.connect(carol).revokeAccess(tokenId, bob.address))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToRevoke");

      await expect(policy.connect(alice).revokeAccess(tokenId, bob.address))
        .to.emit(policy, "AccessRevoked")
        .withArgs(tokenId, bob.address, alice.address);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.NONE);

      await expect(policy.connect(alice).revokeAccess(tokenId, bob.address))
        .to.be.revertedWithCustomError(policy, "NoActiveGrant");
    });

    it("a grant can be re-issued after revocation without duplicating the grantee list", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0);
      await policy.connect(alice).revokeAccess(tokenId, bob.address);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.EDIT, 0);
      expect(await policy.granteesOf(tokenId)).to.deep.equal([bob.address]);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.EDIT);
    });
  });

  describe("delegation", function () {
    it("a MANAGE holder can delegate VIEW/EDIT but never MANAGE", async function () {
      const { policy, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.MANAGE, 0);

      await policy.connect(bob).grantAccess(tokenId, carol.address, LEVEL.EDIT, 0);
      expect(await policy.effectiveLevel(tokenId, carol.address)).to.equal(LEVEL.EDIT);

      await expect(policy.connect(bob).grantAccess(tokenId, carol.address, LEVEL.MANAGE, 0))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToGrant");

      // and a MANAGE holder can revoke what they (or anyone below them) handed out
      await policy.connect(bob).revokeAccess(tokenId, carol.address);
      expect(await policy.effectiveLevel(tokenId, carol.address)).to.equal(LEVEL.NONE);
    });

    it("an EDIT holder cannot delegate anything", async function () {
      const { policy, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.EDIT, 0);
      await expect(policy.connect(bob).grantAccess(tokenId, carol.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToGrant");
    });
  });

  describe("identity and ownership binding", function () {
    it("every grant lapses when the asset changes hands", async function () {
      const { policy, nft, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, carol.address, LEVEL.EDIT, 0);
      expect(await policy.effectiveLevel(tokenId, carol.address)).to.equal(LEVEL.EDIT);

      await nft.connect(alice).transferFrom(alice.address, bob.address, tokenId);

      expect(await policy.effectiveLevel(tokenId, carol.address)).to.equal(LEVEL.NONE);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.MANAGE);
      expect(await policy.effectiveLevel(tokenId, alice.address)).to.equal(LEVEL.NONE);
    });

    it("a suspended grantee loses access instantly; a suspended owner loses MANAGE", async function () {
      const { policy, did, admin, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0);

      await did.connect(admin).deactivate(bob.address);
      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.NONE);

      await did.connect(admin).deactivate(alice.address);
      expect(await policy.effectiveLevel(tokenId, alice.address)).to.equal(LEVEL.NONE);
      // carol is still active, so the only thing stopping this grant is alice's suspension
      await expect(policy.connect(alice).grantAccess(tokenId, carol.address, LEVEL.VIEW, 0))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToGrant");
    });
  });

  describe("gasless grants (EIP-712)", function () {
    it("anyone can submit a grant the owner signed off-chain", async function () {
      const { policy, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      const { req, signature } = await signGrant(policy, alice, {
        tokenId, grantee: bob.address, level: LEVEL.EDIT,
      });

      await expect(policy.connect(carol).grantAccessWithSignature(req, alice.address, signature))
        .to.emit(policy, "AccessGranted")
        .withArgs(tokenId, bob.address, alice.address, LEVEL.EDIT, 0);

      expect(await policy.effectiveLevel(tokenId, bob.address)).to.equal(LEVEL.EDIT);
      expect(await policy.nonces(alice.address)).to.equal(1n);
    });

    it("the same signature cannot be replayed", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      const { req, signature } = await signGrant(policy, alice, { tokenId, grantee: bob.address, level: LEVEL.VIEW });
      await policy.grantAccessWithSignature(req, alice.address, signature);
      await expect(policy.grantAccessWithSignature(req, alice.address, signature))
        .to.be.revertedWithCustomError(policy, "BadNonce")
        .withArgs(1, 0);
    });

    it("rejects an expired deadline", async function () {
      const { policy, tokenId, alice, bob } = await loadFixture(withAsset);
      const deadline = (await time.latest()) - 1;
      const { req, signature } = await signGrant(policy, alice, {
        tokenId, grantee: bob.address, level: LEVEL.VIEW, deadline,
      });
      await expect(policy.grantAccessWithSignature(req, alice.address, signature))
        .to.be.revertedWithCustomError(policy, "SignatureExpired")
        .withArgs(deadline);
    });

    it("rejects a signature from someone other than the claimed signer", async function () {
      const { policy, tokenId, alice, bob, carol } = await loadFixture(withAsset);
      const { req, signature } = await signGrant(policy, carol, { tokenId, grantee: bob.address, level: LEVEL.VIEW, nonce: 0 });
      await expect(policy.grantAccessWithSignature(req, alice.address, signature))
        .to.be.revertedWithCustomError(policy, "InvalidSignature");
    });

    it("a valid signature from someone who is not allowed to grant still fails", async function () {
      const { policy, tokenId, bob, carol } = await loadFixture(withAsset);
      const { req, signature } = await signGrant(policy, carol, { tokenId, grantee: bob.address, level: LEVEL.VIEW });
      await expect(policy.grantAccessWithSignature(req, carol.address, signature))
        .to.be.revertedWithCustomError(policy, "NotAuthorizedToGrant");
    });
  });

  it("grants and revocations land in the audit trail", async function () {
    const { policy, audit, tokenId, alice, bob } = await loadFixture(withAsset);
    const before = await audit.totalEntries();
    await policy.connect(alice).grantAccess(tokenId, bob.address, LEVEL.VIEW, 0);
    await policy.connect(alice).revokeAccess(tokenId, bob.address);

    const granted = await audit.entryAt(before);
    expect(granted.action).to.equal(ACTIONS.ACCESS_GRANTED);
    expect(granted.actor).to.equal(alice.address);
    expect(granted.subject).to.equal(bob.address);
    expect(granted.refId).to.equal(tokenId);

    const revoked = await audit.entryAt(before + 1n);
    expect(revoked.action).to.equal(ACTIONS.ACCESS_REVOKED);
  });
});
