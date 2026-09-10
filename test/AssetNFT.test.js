const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deploySystem, mintTo, ROLES, ACTIONS } = require("./helpers/fixture");

describe("AssetNFT", function () {
  describe("minting", function () {
    it("an issuer mints a traceable NFT bound to the holder's DID", async function () {
      const { nft, did, issuer, alice } = await loadFixture(deploySystem);
      const contentHash = ethers.id("contract-v1.pdf");

      await expect(nft.connect(issuer).mint(alice.address, "ipfs://QmDoc", contentHash, "contract"))
        .to.emit(nft, "AssetMinted")
        .withArgs(1, alice.address, issuer.address, contentHash, "contract", "ipfs://QmDoc");

      expect(await nft.ownerOf(1)).to.equal(alice.address);
      expect(await nft.tokenURI(1)).to.equal("ipfs://QmDoc");
      expect(await nft.ownerDID(1)).to.equal(await did.didOf(alice.address));
      expect(await nft.tokenByContentHash(contentHash)).to.equal(1);

      const asset = await nft.getAsset(1);
      expect(asset.issuer).to.equal(issuer.address);
      expect(asset.category).to.equal("contract");
      expect(asset.frozen).to.equal(false);

      const prov = await nft.provenanceOf(1);
      expect(prov.length).to.equal(1);
      expect(prov[0].from).to.equal(ethers.ZeroAddress);
      expect(prov[0].to).to.equal(alice.address);
    });

    it("non-issuers cannot mint (admin included)", async function () {
      const { nft, admin, alice } = await loadFixture(deploySystem);
      await expect(nft.connect(alice).mint(alice.address, "ipfs://x", ethers.id("x"), "doc"))
        .to.be.revertedWithCustomError(nft, "CallerLacksRole")
        .withArgs(ROLES.ISSUER, alice.address);
      await expect(nft.connect(admin).mint(alice.address, "ipfs://x", ethers.id("x"), "doc"))
        .to.be.revertedWithCustomError(nft, "CallerLacksRole");
    });

    it("cannot mint to an account without a DID", async function () {
      const { nft, issuer, mallory } = await loadFixture(deploySystem);
      await expect(nft.connect(issuer).mint(mallory.address, "ipfs://x", ethers.id("x"), "doc"))
        .to.be.revertedWithCustomError(nft, "IdentityNotVerified")
        .withArgs(mallory.address);
    });

    it("cannot mint to an identity that lacks USER_ROLE", async function () {
      const { nft, issuer, auditor } = await loadFixture(deploySystem);
      await expect(nft.connect(issuer).mint(auditor.address, "ipfs://x", ethers.id("x"), "doc"))
        .to.be.revertedWithCustomError(nft, "RecipientLacksUserRole")
        .withArgs(auditor.address);
    });

    it("the same content cannot be minted twice", async function () {
      const { nft, issuer, alice, bob } = await loadFixture(deploySystem);
      const contentHash = ethers.id("unique-file");
      await nft.connect(issuer).mint(alice.address, "ipfs://a", contentHash, "doc");
      await expect(nft.connect(issuer).mint(bob.address, "ipfs://b", contentHash, "doc"))
        .to.be.revertedWithCustomError(nft, "DuplicateContent")
        .withArgs(contentHash, 1);
    });

    it("rejects an empty content hash", async function () {
      const { nft, issuer, alice } = await loadFixture(deploySystem);
      await expect(nft.connect(issuer).mint(alice.address, "ipfs://x", ethers.ZeroHash, "doc"))
        .to.be.revertedWithCustomError(nft, "EmptyContentHash");
    });
  });

  describe("transfers", function () {
    it("moves between two verified users and extends the provenance chain", async function () {
      const { nft, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);

      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, tokenId))
        .to.emit(nft, "Transfer")
        .withArgs(alice.address, bob.address, tokenId);

      expect(await nft.ownerOf(tokenId)).to.equal(bob.address);
      const prov = await nft.provenanceOf(tokenId);
      expect(prov.length).to.equal(2);
      expect(prov[1].from).to.equal(alice.address);
      expect(prov[1].to).to.equal(bob.address);
      expect(prov[1].operator).to.equal(alice.address);
      expect(await nft.assetsOf(bob.address)).to.deep.equal([tokenId]);
      expect(await nft.assetsOf(alice.address)).to.deep.equal([]);
    });

    it("cannot be sent to an account without a DID", async function () {
      const { nft, issuer, alice, mallory } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await expect(nft.connect(alice).transferFrom(alice.address, mallory.address, tokenId))
        .to.be.revertedWithCustomError(nft, "IdentityNotVerified")
        .withArgs(mallory.address);
    });

    it("cannot be sent to an identity without USER_ROLE", async function () {
      const { nft, issuer, alice, auditor } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await expect(nft.connect(alice).transferFrom(alice.address, auditor.address, tokenId))
        .to.be.revertedWithCustomError(nft, "RecipientLacksUserRole");
    });

    it("cannot be moved by someone who is not the owner or approved", async function () {
      const { nft, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await expect(nft.connect(bob).transferFrom(alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");
    });

    it("is blocked while the sender's identity is suspended", async function () {
      const { nft, did, admin, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);

      await did.connect(admin).deactivate(alice.address);
      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(nft, "IdentityNotVerified")
        .withArgs(alice.address);

      await did.connect(admin).reactivate(alice.address);
      await nft.connect(alice).transferFrom(alice.address, bob.address, tokenId);
      expect(await nft.ownerOf(tokenId)).to.equal(bob.address);
    });

    it("is blocked when the recipient's USER_ROLE was revoked", async function () {
      const { nft, roles, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await roles.revokeRole(ROLES.USER, bob.address);
      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(nft, "RecipientLacksUserRole");
    });
  });

  describe("freezing", function () {
    it("admin can freeze an asset in place and later release it", async function () {
      const { nft, admin, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);

      await expect(nft.connect(admin).setFrozen(tokenId, true))
        .to.emit(nft, "AssetFrozenSet")
        .withArgs(tokenId, admin.address, true);

      await expect(nft.connect(alice).transferFrom(alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(nft, "AssetFrozen")
        .withArgs(tokenId);

      await nft.connect(admin).setFrozen(tokenId, false);
      await nft.connect(alice).transferFrom(alice.address, bob.address, tokenId);
    });

    it("only admins can freeze", async function () {
      const { nft, issuer, alice } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await expect(nft.connect(alice).setFrozen(tokenId, true))
        .to.be.revertedWithCustomError(nft, "CallerLacksRole")
        .withArgs(ROLES.ADMIN, alice.address);
      await expect(nft.connect(issuer).setFrozen(tokenId, true))
        .to.be.revertedWithCustomError(nft, "CallerLacksRole");
    });
  });

  describe("retiring", function () {
    it("the owner can retire an asset; history survives and the content hash is freed", async function () {
      const { nft, issuer, alice } = await loadFixture(deploySystem);
      const { tokenId, contentHash } = await mintTo(nft, issuer, alice);

      await expect(nft.connect(alice).retire(tokenId))
        .to.emit(nft, "AssetRetired")
        .withArgs(tokenId, alice.address, alice.address);

      await expect(nft.ownerOf(tokenId)).to.be.revertedWithCustomError(nft, "ERC721NonexistentToken");
      expect(await nft.tokenByContentHash(contentHash)).to.equal(0);
      expect((await nft.provenanceOf(tokenId)).length).to.equal(2);
      expect((await nft.getAsset(tokenId)).contentHash).to.equal(contentHash);
    });

    it("strangers cannot retire; admins can", async function () {
      const { nft, admin, issuer, alice, bob } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await expect(nft.connect(bob).retire(tokenId))
        .to.be.revertedWithCustomError(nft, "NotOwnerNorAdmin");
      await nft.connect(admin).retire(tokenId);
    });

    it("a frozen asset can only be retired by an admin", async function () {
      const { nft, admin, issuer, alice } = await loadFixture(deploySystem);
      const { tokenId } = await mintTo(nft, issuer, alice);
      await nft.connect(admin).setFrozen(tokenId, true);
      await expect(nft.connect(alice).retire(tokenId)).to.be.revertedWithCustomError(nft, "AssetFrozen");
      await nft.connect(admin).retire(tokenId);
    });
  });

  describe("audit", function () {
    it("mint and transfer both land in the audit trail", async function () {
      const { nft, audit, issuer, alice, bob } = await loadFixture(deploySystem);
      const before = await audit.totalEntries();
      const { tokenId, contentHash } = await mintTo(nft, issuer, alice);
      await nft.connect(alice).transferFrom(alice.address, bob.address, tokenId);

      const minted = await audit.entryAt(before);
      expect(minted.action).to.equal(ACTIONS.ASSET_MINTED);
      expect(minted.actor).to.equal(issuer.address);
      expect(minted.subject).to.equal(alice.address);
      expect(minted.refId).to.equal(tokenId);
      expect(minted.dataHash).to.equal(contentHash);

      const moved = await audit.entryAt(before + 1n);
      expect(moved.action).to.equal(ACTIONS.ASSET_TRANSFERRED);
      expect(moved.actor).to.equal(alice.address);
      expect(moved.subject).to.equal(bob.address);
      expect(moved.refId).to.equal(tokenId);
    });
  });

  it("advertises ERC-721, Enumerable and Metadata interfaces", async function () {
    const { nft } = await loadFixture(deploySystem);
    expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC721
    expect(await nft.supportsInterface("0x780e9d63")).to.equal(true); // ERC721Enumerable
    expect(await nft.supportsInterface("0x5b5e139f")).to.equal(true); // ERC721Metadata
  });
});
