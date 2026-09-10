const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, registerDID, signCredential } = require("./helpers/fixture");

describe("DIDRegistry", function () {
  describe("registration", function () {
    it("creates a did:yhack:<chainId>:<address> identity for the caller", async function () {
      const { did, alice } = await loadFixture(deploySystem);
      const { chainId } = await ethers.provider.getNetwork();

      expect(await did.isVerified(alice.address)).to.equal(true);
      expect(await did.didOf(alice.address)).to.equal(`did:yhack:${chainId}:${alice.address.toLowerCase()}`);
      expect(await did.controllerOf(alice.address)).to.equal(alice.address);
    });

    it("returns an empty DID for accounts that never registered", async function () {
      const { did, mallory } = await loadFixture(deploySystem);
      expect(await did.isVerified(mallory.address)).to.equal(false);
      expect(await did.didOf(mallory.address)).to.equal("");
    });

    it("rejects a second registration from the same address", async function () {
      const { did, alice } = await loadFixture(deploySystem);
      await expect(did.connect(alice).register("ipfs://again", ethers.id("x")))
        .to.be.revertedWithCustomError(did, "AlreadyRegistered")
        .withArgs(alice.address);
    });

    it("rejects an empty document hash", async function () {
      const { did, mallory } = await loadFixture(deploySystem);
      await expect(did.connect(mallory).register("ipfs://empty", ethers.ZeroHash))
        .to.be.revertedWithCustomError(did, "EmptyDocument");
    });

    it("nobody can register an identity on someone else's behalf", async function () {
      const { did, admin, mallory } = await loadFixture(deploySystem);
      // There is simply no function for it; the closest thing an admin could try
      // is registering from its own key, which only ever affects the admin.
      await expect(did.connect(admin).register("ipfs://x", ethers.id("x")))
        .to.be.revertedWithCustomError(did, "AlreadyRegistered");
      expect(await did.isVerified(mallory.address)).to.equal(false);
    });
  });

  describe("document control", function () {
    it("only the controller can update the DID document", async function () {
      const { did, alice, bob } = await loadFixture(deploySystem);
      const newHash = ethers.id("v2");

      await expect(did.connect(bob).updateDocument(alice.address, newHash, "ipfs://v2"))
        .to.be.revertedWithCustomError(did, "NotController")
        .withArgs(bob.address, alice.address);

      await expect(did.connect(alice).updateDocument(alice.address, newHash, "ipfs://v2"))
        .to.emit(did, "IdentityUpdated")
        .withArgs(alice.address, alice.address, newHash, "ipfs://v2");

      expect((await did.getIdentity(alice.address)).docHash).to.equal(newHash);
    });

    it("rotating the controller moves edit rights without moving the identity", async function () {
      const { did, alice, bob } = await loadFixture(deploySystem);

      await expect(did.connect(alice).rotateController(alice.address, bob.address))
        .to.emit(did, "ControllerRotated")
        .withArgs(alice.address, alice.address, bob.address);

      // identity still belongs to alice's address ...
      expect(await did.isVerified(alice.address)).to.equal(true);
      // ... but alice's old key can no longer edit it, bob's can
      await expect(did.connect(alice).updateDocument(alice.address, ethers.id("z"), "ipfs://z"))
        .to.be.revertedWithCustomError(did, "NotController");
      await did.connect(bob).updateDocument(alice.address, ethers.id("z"), "ipfs://z");
    });
  });

  describe("deactivation", function () {
    it("the subject can suspend and restore their own identity", async function () {
      const { did, alice } = await loadFixture(deploySystem);

      await expect(did.connect(alice).deactivate(alice.address))
        .to.emit(did, "IdentityDeactivated")
        .withArgs(alice.address, alice.address, false);
      expect(await did.isVerified(alice.address)).to.equal(false);

      await did.connect(alice).reactivate(alice.address);
      expect(await did.isVerified(alice.address)).to.equal(true);
    });

    it("an admin suspension can only be lifted by an admin", async function () {
      const { did, admin, alice } = await loadFixture(deploySystem);

      await expect(did.connect(admin).deactivate(alice.address))
        .to.emit(did, "IdentityDeactivated")
        .withArgs(alice.address, admin.address, true);

      await expect(did.connect(alice).reactivate(alice.address))
        .to.be.revertedWithCustomError(did, "AdminLocked")
        .withArgs(alice.address);

      await did.connect(admin).reactivate(alice.address);
      expect(await did.isVerified(alice.address)).to.equal(true);
    });

    it("a stranger cannot deactivate someone else's identity", async function () {
      const { did, alice, bob } = await loadFixture(deploySystem);
      await expect(did.connect(bob).deactivate(alice.address))
        .to.be.revertedWithCustomError(did, "NotController");
    });
  });

  describe("verifiable credentials", function () {
    const schema = ethers.id("KYC_LEVEL_2");
    const claimHash = ethers.id("kyc-report-cid");

    it("anchors an EIP-712 credential signed by an issuer, submitted by anyone", async function () {
      const { did, issuer, alice, carol } = await loadFixture(deploySystem);
      const { value, signature } = await signCredential(did, issuer, { subject: alice.address, schema, claimHash });

      const credentialId = await did.credentialDigest(
        value.issuer, value.subject, value.schema, value.claimHash, value.expiresAt, value.nonce
      );

      await expect(
        did.connect(carol).anchorCredential(
          value.issuer, value.subject, value.schema, value.claimHash, value.expiresAt, value.nonce, signature
        )
      ).to.emit(did, "CredentialAnchored").withArgs(credentialId, issuer.address, alice.address, schema, claimHash, 0);

      expect(await did.isCredentialValid(credentialId)).to.equal(true);
      expect(await did.credentialsOf(alice.address)).to.deep.equal([credentialId]);
      expect(await did.nonces(issuer.address)).to.equal(1n);
    });

    it("the same signature cannot be anchored twice (nonce replay)", async function () {
      const { did, issuer, alice } = await loadFixture(deploySystem);
      const { value, signature } = await signCredential(did, issuer, { subject: alice.address, schema, claimHash });
      const args = [value.issuer, value.subject, value.schema, value.claimHash, value.expiresAt, value.nonce, signature];

      await did.anchorCredential(...args);
      await expect(did.anchorCredential(...args))
        .to.be.revertedWithCustomError(did, "BadNonce")
        .withArgs(1, 0);
    });

    it("rejects a credential whose signer is not the claimed issuer", async function () {
      const { did, issuer, alice, bob } = await loadFixture(deploySystem);
      // bob signs, but the payload names issuer
      const { value, signature } = await signCredential(did, bob, { subject: alice.address, schema, claimHash });
      value.issuer = issuer.address;

      await expect(
        did.anchorCredential(value.issuer, value.subject, value.schema, value.claimHash, value.expiresAt, value.nonce, signature)
      ).to.be.revertedWithCustomError(did, "InvalidSignature");
    });

    it("rejects a credential signed by an account without ISSUER_ROLE", async function () {
      const { did, alice, bob } = await loadFixture(deploySystem);
      const { value, signature } = await signCredential(did, bob, { subject: alice.address, schema, claimHash });

      await expect(
        did.anchorCredential(value.issuer, value.subject, value.schema, value.claimHash, value.expiresAt, value.nonce, signature)
      ).to.be.revertedWithCustomError(did, "NotIssuer").withArgs(bob.address);
    });

    it("issuers can also issue directly on-chain; non-issuers cannot", async function () {
      const { did, issuer, alice, bob } = await loadFixture(deploySystem);

      await expect(did.connect(bob).issueCredential(alice.address, schema, claimHash, 0))
        .to.be.revertedWithCustomError(did, "NotIssuer");

      await expect(did.connect(issuer).issueCredential(alice.address, schema, claimHash, 0))
        .to.emit(did, "CredentialAnchored");
    });

    it("cannot issue to an unregistered subject", async function () {
      const { did, issuer, mallory } = await loadFixture(deploySystem);
      await expect(did.connect(issuer).issueCredential(mallory.address, schema, claimHash, 0))
        .to.be.revertedWithCustomError(did, "IdentityNotFound")
        .withArgs(mallory.address);
    });

    it("expires on schedule", async function () {
      const { did, issuer, alice } = await loadFixture(deploySystem);
      const expiresAt = (await time.latest()) + 3600;

      const tx = await did.connect(issuer).issueCredential(alice.address, schema, claimHash, expiresAt);
      await tx.wait();
      const [credentialId] = await did.credentialsOf(alice.address);

      expect(await did.isCredentialValid(credentialId)).to.equal(true);
      await time.increase(3601);
      expect(await did.isCredentialValid(credentialId)).to.equal(false);
    });

    it("issuer can revoke; strangers cannot", async function () {
      const { did, issuer, alice, bob } = await loadFixture(deploySystem);
      await did.connect(issuer).issueCredential(alice.address, schema, claimHash, 0);
      const [credentialId] = await did.credentialsOf(alice.address);

      await expect(did.connect(bob).revokeCredential(credentialId))
        .to.be.revertedWithCustomError(did, "NotCredentialIssuer");

      await expect(did.connect(issuer).revokeCredential(credentialId))
        .to.emit(did, "CredentialRevoked")
        .withArgs(credentialId, issuer.address);
      expect(await did.isCredentialValid(credentialId)).to.equal(false);

      await expect(did.connect(issuer).revokeCredential(credentialId))
        .to.be.revertedWithCustomError(did, "CredentialAlreadyRevoked");
    });

    it("becomes invalid when the subject's identity is deactivated", async function () {
      const { did, issuer, alice } = await loadFixture(deploySystem);
      await did.connect(issuer).issueCredential(alice.address, schema, claimHash, 0);
      const [credentialId] = await did.credentialsOf(alice.address);

      await did.connect(alice).deactivate(alice.address);
      expect(await did.isCredentialValid(credentialId)).to.equal(false);
    });
  });

  describe("wiring", function () {
    it("role manager and audit trail can only be set once, by the admin", async function () {
      const { did, roles, alice } = await loadFixture(deploySystem);
      await expect(did.connect(alice).setRoleManager(alice.address))
        .to.be.revertedWithCustomError(did, "NotAdmin");
      await expect(did.setRoleManager(await roles.getAddress()))
        .to.be.revertedWithCustomError(did, "AlreadySet");
    });

    it("a freshly registered identity is enumerable", async function () {
      const { did, mallory } = await loadFixture(deploySystem);
      const before = await did.totalIdentities();
      await registerDID(did, mallory);
      expect(await did.totalIdentities()).to.equal(before + 1n);
      expect(await did.subjectAt(before)).to.equal(mallory.address);
    });
  });
});
