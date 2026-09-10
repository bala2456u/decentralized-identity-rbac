const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, registerDID, ROLES } = require("./helpers/fixture");

describe("RoleManager", function () {
  it("seeds the deployer as root admin and admin", async function () {
    const { roles, admin } = await loadFixture(deploySystem);
    const r = await roles.rolesOf(admin.address);
    expect(r.isRootAdmin).to.equal(true);
    expect(r.isAdmin).to.equal(true);
    expect(r.isIssuer).to.equal(false);
  });

  it("refuses to deploy when the admin has no identity", async function () {
    const { did, mallory } = await loadFixture(deploySystem);
    const RoleManager = await ethers.getContractFactory("RoleManager");
    await expect(RoleManager.deploy(mallory.address, await did.getAddress()))
      .to.be.revertedWithCustomError(RoleManager, "IdentityNotVerified")
      .withArgs(mallory.address);
  });

  describe("granting", function () {
    it("cannot grant any role to an account without a DID", async function () {
      const { roles, mallory } = await loadFixture(deploySystem);
      await expect(roles.grantRole(ROLES.USER, mallory.address))
        .to.be.revertedWithCustomError(roles, "IdentityNotVerified")
        .withArgs(mallory.address);
    });

    it("only the role's admin role can grant it", async function () {
      const { roles, issuer, alice, bob } = await loadFixture(deploySystem);

      // issuer holds ISSUER_ROLE, whose admin is ADMIN_ROLE — issuer lacks it
      await expect(roles.connect(issuer).grantRole(ROLES.USER, bob.address))
        .to.be.revertedWithCustomError(roles, "CallerLacksValidRole")
        .withArgs(ROLES.ADMIN, issuer.address);

      // a plain user certainly cannot make themselves admin
      await expect(roles.connect(alice).grantRole(ROLES.ADMIN, alice.address))
        .to.be.revertedWithCustomError(roles, "CallerLacksValidRole")
        .withArgs(ROLES.DEFAULT_ADMIN, alice.address);
    });

    it("an admin can promote a registered user to issuer", async function () {
      const { roles, admin, alice } = await loadFixture(deploySystem);
      await expect(roles.connect(admin).grantRole(ROLES.ISSUER, alice.address))
        .to.emit(roles, "RoleGranted")
        .withArgs(ROLES.ISSUER, alice.address, admin.address);
      expect(await roles.hasValidRole(ROLES.ISSUER, alice.address)).to.equal(true);
    });
  });

  describe("expiry", function () {
    it("a time-boxed role lapses on its own", async function () {
      const { roles, did, mallory } = await loadFixture(deploySystem);
      await registerDID(did, mallory);
      const expiresAt = (await time.latest()) + 86400;

      await expect(roles.grantRoleWithExpiry(ROLES.AUDITOR, mallory.address, expiresAt))
        .to.emit(roles, "RoleExpirySet")
        .withArgs(ROLES.AUDITOR, mallory.address, expiresAt);

      expect(await roles.hasValidRole(ROLES.AUDITOR, mallory.address)).to.equal(true);
      expect(await roles.roleExpiry(ROLES.AUDITOR, mallory.address)).to.equal(expiresAt);

      await time.increase(86401);

      // raw AccessControl still says yes; the enforced view says no
      expect(await roles.hasRole(ROLES.AUDITOR, mallory.address)).to.equal(true);
      expect(await roles.hasValidRole(ROLES.AUDITOR, mallory.address)).to.equal(false);
    });

    it("rejects an expiry in the past", async function () {
      const { roles, alice } = await loadFixture(deploySystem);
      const past = (await time.latest()) - 1;
      await expect(roles.grantRoleWithExpiry(ROLES.AUDITOR, alice.address, past))
        .to.be.revertedWithCustomError(roles, "ExpiryInPast")
        .withArgs(past);
    });
  });

  describe("identity binding", function () {
    it("deactivating an identity voids every role it holds; reactivating restores them", async function () {
      const { roles, did, issuer } = await loadFixture(deploySystem);
      expect(await roles.hasValidRole(ROLES.ISSUER, issuer.address)).to.equal(true);

      await did.connect(issuer).deactivate(issuer.address);
      expect(await roles.hasValidRole(ROLES.ISSUER, issuer.address)).to.equal(false);

      await did.connect(issuer).reactivate(issuer.address);
      expect(await roles.hasValidRole(ROLES.ISSUER, issuer.address)).to.equal(true);
    });

    it("an admin whose identity is suspended loses admin powers too", async function () {
      const { roles, did, admin, alice } = await loadFixture(deploySystem);
      await did.connect(admin).deactivate(admin.address);

      await expect(roles.connect(admin).grantRole(ROLES.ISSUER, alice.address))
        .to.be.revertedWithCustomError(roles, "CallerLacksValidRole");

      // recovery path: DIDRegistry.admin is a plain address check, not identity-gated
      await did.connect(admin).reactivate(admin.address);
      await roles.connect(admin).grantRole(ROLES.ISSUER, alice.address);
    });

    it("roles can still be revoked from an account whose identity is suspended", async function () {
      const { roles, did, admin, issuer } = await loadFixture(deploySystem);
      await did.connect(admin).deactivate(issuer.address);

      await expect(roles.connect(admin).revokeRole(ROLES.ISSUER, issuer.address))
        .to.emit(roles, "RoleRevoked")
        .withArgs(ROLES.ISSUER, issuer.address, admin.address);

      await did.connect(admin).reactivate(issuer.address);
      expect(await roles.hasValidRole(ROLES.ISSUER, issuer.address)).to.equal(false);
    });
  });

  describe("revoking", function () {
    it("only the role's admin role can revoke", async function () {
      const { roles, alice, bob } = await loadFixture(deploySystem);
      await expect(roles.connect(alice).revokeRole(ROLES.USER, bob.address))
        .to.be.revertedWithCustomError(roles, "CallerLacksValidRole");
    });

    it("revocation clears any expiry", async function () {
      const { roles, admin, alice } = await loadFixture(deploySystem);
      const expiresAt = (await time.latest()) + 3600;
      await roles.grantRoleWithExpiry(ROLES.AUDITOR, alice.address, expiresAt);
      await roles.connect(admin).revokeRole(ROLES.AUDITOR, alice.address);
      expect(await roles.roleExpiry(ROLES.AUDITOR, alice.address)).to.equal(0);
      expect(await roles.hasValidRole(ROLES.AUDITOR, alice.address)).to.equal(false);
    });
  });
});
