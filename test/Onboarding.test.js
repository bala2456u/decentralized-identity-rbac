const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, registerDID, ROLES, STATUS, ACTIONS } = require("./helpers/fixture");

const DATA_HASH = ethers.id("onboarding-form-dave");

async function submitted() {
  const ctx = await deploySystem();
  await ctx.onboarding.connect(ctx.dave).submit("STAFF-1042", "Dave Kumar", "Procurement", DATA_HASH);
  return ctx;
}

async function hodApproved() {
  const ctx = await submitted();
  await ctx.onboarding.connect(ctx.hod).approveByHOD(ctx.dave.address);
  return ctx;
}

describe("Onboarding", function () {
  describe("submitting", function () {
    it("an applicant with an active DID submits their details and gets a readable profile", async function () {
      const { onboarding, dave } = await loadFixture(deploySystem);

      await expect(onboarding.connect(dave).submit("STAFF-1042", "Dave Kumar", "Procurement", DATA_HASH))
        .to.emit(onboarding, "RequestSubmitted")
        .withArgs(dave.address, "STAFF-1042", "Dave Kumar", "Procurement", DATA_HASH);

      expect(await onboarding.statusOf(dave.address)).to.equal(STATUS.PENDING_HOD);
      expect(await onboarding.resolveStaffId("STAFF-1042")).to.equal(dave.address);

      const profile = await onboarding.profileOf(dave.address);
      expect(profile.staffId).to.equal("STAFF-1042");
      expect(profile.displayName).to.equal("Dave Kumar");
      expect(profile.department).to.equal("Procurement");
      expect(profile.approved).to.equal(false);

      expect(await onboarding.pendingAt(STATUS.PENDING_HOD)).to.deep.equal([dave.address]);
    });

    it("requires an active DID — step 1 cannot be skipped", async function () {
      const { onboarding, mallory } = await loadFixture(deploySystem);
      await expect(onboarding.connect(mallory).submit("STAFF-9", "Mallory", "Procurement", DATA_HASH))
        .to.be.revertedWithCustomError(onboarding, "IdentityNotVerified")
        .withArgs(mallory.address);
    });

    it("a Staff ID can belong to one identity only", async function () {
      const { onboarding, dave, hod, did, mallory } = await loadFixture(submitted);
      await registerDID(did, mallory);
      await expect(onboarding.connect(mallory).submit("STAFF-1042", "Impostor", "Procurement", DATA_HASH))
        .to.be.revertedWithCustomError(onboarding, "StaffIdTaken")
        .withArgs("STAFF-1042", dave.address);
    });

    it("cannot submit again while a request is pending or approved", async function () {
      const { onboarding, dave } = await loadFixture(submitted);
      await expect(onboarding.connect(dave).submit("STAFF-1042", "Dave Kumar", "Procurement", DATA_HASH))
        .to.be.revertedWithCustomError(onboarding, "RequestExists")
        .withArgs(dave.address, STATUS.PENDING_HOD);
    });

    it("rejects empty Staff ID or department", async function () {
      const { onboarding, dave } = await loadFixture(deploySystem);
      await expect(onboarding.connect(dave).submit("", "Dave", "Procurement", DATA_HASH))
        .to.be.revertedWithCustomError(onboarding, "EmptyField").withArgs("staffId");
      await expect(onboarding.connect(dave).submit("STAFF-1", "Dave", "", DATA_HASH))
        .to.be.revertedWithCustomError(onboarding, "EmptyField").withArgs("department");
    });
  });

  describe("the order is enforced", function () {
    it("an admin cannot approve before the Head of Department has", async function () {
      const { onboarding, admin, dave } = await loadFixture(submitted);
      await expect(onboarding.connect(admin).approveByAdmin(dave.address))
        .to.be.revertedWithCustomError(onboarding, "WrongStage")
        .withArgs(dave.address, STATUS.PENDING_ADMIN, STATUS.PENDING_HOD);
    });

    it("only the head of the applicant's own department can give first approval", async function () {
      const { onboarding, roles, did, admin, alice, dave } = await loadFixture(submitted);

      // alice is a plain user
      await expect(onboarding.connect(alice).approveByHOD(dave.address))
        .to.be.revertedWithCustomError(onboarding, "CallerLacksRole")
        .withArgs(ROLES.HOD, alice.address);

      // make alice an HOD, but of a different department
      await roles.connect(admin).grantRole(ROLES.HOD, alice.address);
      await onboarding.connect(admin).setDepartmentHead("Finance", alice.address);
      await expect(onboarding.connect(alice).approveByHOD(dave.address))
        .to.be.revertedWithCustomError(onboarding, "NotDepartmentHead")
        .withArgs(alice.address, "Procurement");
    });

    it("the Head of Department approves and the request moves to the admin stage", async function () {
      const { onboarding, hod, dave } = await loadFixture(submitted);
      await expect(onboarding.connect(hod).approveByHOD(dave.address))
        .to.emit(onboarding, "RequestApprovedByHOD")
        .withArgs(dave.address, hod.address);

      const r = await onboarding.getRequest(dave.address);
      expect(r.status).to.equal(STATUS.PENDING_ADMIN);
      expect(r.hodApprover).to.equal(hod.address);
      expect(await onboarding.pendingAt(STATUS.PENDING_HOD)).to.deep.equal([]);
      expect(await onboarding.pendingAt(STATUS.PENDING_ADMIN)).to.deep.equal([dave.address]);
    });

    it("the HOD cannot approve twice, and cannot do the admin's step", async function () {
      const { onboarding, hod, dave } = await loadFixture(hodApproved);
      await expect(onboarding.connect(hod).approveByHOD(dave.address))
        .to.be.revertedWithCustomError(onboarding, "WrongStage");
      await expect(onboarding.connect(hod).approveByAdmin(dave.address))
        .to.be.revertedWithCustomError(onboarding, "CallerLacksRole")
        .withArgs(ROLES.ADMIN, hod.address);
    });

    it("final admin approval grants USER_ROLE automatically, attributed to the approving admin", async function () {
      const { onboarding, roles, audit, admin, dave } = await loadFixture(hodApproved);
      expect(await roles.hasValidRole(ROLES.USER, dave.address)).to.equal(false);
      const before = await audit.totalEntries();

      await expect(onboarding.connect(admin).approveByAdmin(dave.address))
        .to.emit(onboarding, "RequestApproved")
        .withArgs(dave.address, admin.address)
        .and.to.emit(roles, "RoleGranted")
        .withArgs(ROLES.USER, dave.address, await onboarding.getAddress());

      expect(await roles.hasValidRole(ROLES.USER, dave.address)).to.equal(true);
      expect(await onboarding.statusOf(dave.address)).to.equal(STATUS.APPROVED);
      expect((await onboarding.profileOf(dave.address)).approved).to.equal(true);

      // audit: the role grant names the admin as actor, then the approval itself
      const grant = await audit.entryAt(before);
      expect(grant.action).to.equal(ACTIONS.ROLE_GRANTED);
      expect(grant.actor).to.equal(admin.address);
      expect(grant.subject).to.equal(dave.address);
      const approved = await audit.entryAt(before + 1n);
      expect(approved.action).to.equal(ACTIONS.ONBOARDING_APPROVED);
      expect(approved.actor).to.equal(admin.address);
    });

    it("nobody can approve their own request", async function () {
      const { onboarding, roles, admin, hod } = await loadFixture(deploySystem);
      // the HOD applies for onboarding in the department they head
      await onboarding.connect(hod).submit("STAFF-0010", "Arjun Rao", "Procurement", DATA_HASH);
      await expect(onboarding.connect(hod).approveByHOD(hod.address))
        .to.be.revertedWithCustomError(onboarding, "SelfApproval")
        .withArgs(hod.address);

      // an admin who applies cannot give themselves the final approval either
      await onboarding.connect(admin).submit("STAFF-0001", "Priya Nair", "Procurement", DATA_HASH);
      await onboarding.connect(hod).approveByHOD(admin.address);
      await expect(onboarding.connect(admin).approveByAdmin(admin.address))
        .to.be.revertedWithCustomError(onboarding, "SelfApproval");
    });

    it("final approval fails if the applicant's identity was suspended in the meantime", async function () {
      const { onboarding, did, admin, dave } = await loadFixture(hodApproved);
      await did.connect(admin).deactivate(dave.address);
      await expect(onboarding.connect(admin).approveByAdmin(dave.address))
        .to.be.revertedWithCustomError(onboarding, "IdentityNotVerified")
        .withArgs(dave.address);
    });
  });

  describe("rejection and resubmission", function () {
    it("the HOD can reject at stage one with a reason; the applicant can resubmit", async function () {
      const { onboarding, hod, dave } = await loadFixture(submitted);

      await expect(onboarding.connect(hod).reject(dave.address, "Staff ID does not match HR records"))
        .to.emit(onboarding, "RequestRejected")
        .withArgs(dave.address, hod.address, STATUS.PENDING_HOD, "Staff ID does not match HR records");

      const r = await onboarding.getRequest(dave.address);
      expect(r.status).to.equal(STATUS.REJECTED);
      expect(r.rejectReason).to.equal("Staff ID does not match HR records");

      // resubmit with a corrected Staff ID: the old one is released
      await onboarding.connect(dave).submit("STAFF-1043", "Dave Kumar", "Procurement", DATA_HASH);
      expect(await onboarding.statusOf(dave.address)).to.equal(STATUS.PENDING_HOD);
      expect(await onboarding.resolveStaffId("STAFF-1042")).to.equal(ethers.ZeroAddress);
      expect(await onboarding.resolveStaffId("STAFF-1043")).to.equal(dave.address);
      expect(await onboarding.totalApplicants()).to.equal(1);
    });

    it("an admin can reject at either stage; the HOD cannot reject once it has left their desk", async function () {
      const { onboarding, admin, hod, dave } = await loadFixture(hodApproved);
      await expect(onboarding.connect(hod).reject(dave.address, "changed my mind"))
        .to.be.revertedWithCustomError(onboarding, "NotAuthorizedToReject");
      await onboarding.connect(admin).reject(dave.address, "background check pending");
      expect(await onboarding.statusOf(dave.address)).to.equal(STATUS.REJECTED);
    });

    it("strangers cannot reject, and nothing can be rejected twice", async function () {
      const { onboarding, alice, hod, dave } = await loadFixture(submitted);
      await expect(onboarding.connect(alice).reject(dave.address, "x"))
        .to.be.revertedWithCustomError(onboarding, "NotAuthorizedToReject");
      await onboarding.connect(hod).reject(dave.address, "x");
      await expect(onboarding.connect(hod).reject(dave.address, "again"))
        .to.be.revertedWithCustomError(onboarding, "WrongStage");
    });
  });

  describe("administration", function () {
    it("only admins appoint department heads, and a head must hold HOD_ROLE", async function () {
      const { onboarding, alice, bob, admin } = await loadFixture(deploySystem);
      await expect(onboarding.connect(alice).setDepartmentHead("Finance", bob.address))
        .to.be.revertedWithCustomError(onboarding, "CallerLacksRole");
      await expect(onboarding.connect(admin).setDepartmentHead("Finance", bob.address))
        .to.be.revertedWithCustomError(onboarding, "NotHOD")
        .withArgs(bob.address);
      // clearing is allowed
      await onboarding.connect(admin).setDepartmentHead("Procurement", ethers.ZeroAddress);
      expect(await onboarding.departmentHead("Procurement")).to.equal(ethers.ZeroAddress);
    });

    it("admins can record a profile for privileged staff without granting any role", async function () {
      const { onboarding, roles, admin, issuer } = await loadFixture(deploySystem);
      await expect(onboarding.connect(admin).setProfileByAdmin(issuer.address, "STAFF-0002", "Ravi Shankar", "Records Office"))
        .to.emit(onboarding, "ProfileSetByAdmin")
        .withArgs(issuer.address, admin.address, "STAFF-0002", "Records Office");

      const p = await onboarding.profileOf(issuer.address);
      expect(p.displayName).to.equal("Ravi Shankar");
      expect(p.approved).to.equal(true);
      expect(await roles.hasValidRole(ROLES.USER, issuer.address)).to.equal(false);
    });

    it("the RoleManager only accepts onboarding grants from the Onboarding contract", async function () {
      const { roles, admin, alice, dave } = await loadFixture(deploySystem);
      await expect(roles.connect(admin).grantUserRoleFromOnboarding(dave.address, admin.address))
        .to.be.revertedWithCustomError(roles, "NotOnboarding")
        .withArgs(admin.address);
      await expect(roles.connect(alice).grantUserRoleFromOnboarding(dave.address, alice.address))
        .to.be.revertedWithCustomError(roles, "NotOnboarding");
    });
  });
});
