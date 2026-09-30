// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Deliberately minimal ERC-721 for Byakugan's deterministic integration fixture.
 *
 * NOT a production token and not trying to be: no approvals worth the name, no
 * safeTransfer callbacks, no enumerability. It exists to emit exactly the logs the
 * indexer decodes, on demand, in shapes chosen rather than found. Self-contained
 * with no imports so it deploys from one file with no dependency install.
 *
 * It can produce every `kind` the classifier assigns, on real chain data:
 *
 *   mint      mint() / mintManyTo()      from == 0x0
 *   buy       buy()                      payable, and tx.from == the recipient
 *   transfer  transferFrom()             neither endpoint is 0x0, no value
 *   burn      burn()                     to == 0x0
 *
 * `buy()` is the one worth explaining: the classifier's buy rule is
 * `tx.value > 0 && tx.from == to`, so a payable function that sends the token to
 * `msg.sender` satisfies it exactly. Without this, a fixture can only ever exercise
 * three of the four branches and the `buy` path stays tested against mocks alone.
 *
 * DENSITY. `mintManyTo` puts many mints in ONE transaction, which is the airdrop
 * and bot pattern — and note what that does to enrichment cost: 200 mints sharing
 * one transaction is 200 transfers needing ONE fetch, the cheapest case there is.
 * The expensive case is the opposite, many SEPARATE transactions landing in one
 * block, and no contract can cause that: it is a property of how transactions are
 * bundled, not of what they call. See the README for how that extreme is produced.
 */
contract FixtureERC721 {
    string public name = "Byakugan Fixture 721";
    string public symbol = "BYK721";

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    uint256 public nextTokenId = 1;

    /**
     * ERC-165. `0xffffffff` MUST answer false — that is the conformance check
     * src/chain/standard.ts runs FIRST, to unmask a contract that returns true to
     * everything and would otherwise be detected as whatever was asked about
     * first. A fixture that failed it would make the detector's own guard untestable
     * against real bytecode.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        if (interfaceId == 0xffffffff) return false;
        return interfaceId == 0x01ffc9a7    // ERC-165
            || interfaceId == 0x80ac58cd;   // ERC-721
    }

    function mint(address to) public returns (uint256 tokenId) {
        require(to != address(0), "mint to zero");
        tokenId = nextTokenId++;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    /** Many mints, one transaction, one log each. The airdrop / bot shape. */
    function mintManyTo(address[] calldata recipients) external {
        for (uint256 i = 0; i < recipients.length; i++) {
            mint(recipients[i]);
        }
    }

    /** Paid acquisition by the caller: tx.value > 0 and tx.from == to, so `buy`. */
    function buy(uint256 tokenId) external payable {
        require(msg.value > 0, "buy needs value");
        address owner = ownerOf[tokenId];
        require(owner != address(0), "no such token");
        require(owner != msg.sender, "already yours");
        _move(owner, msg.sender, tokenId);
    }

    /** Unpaid movement between two non-zero addresses, so `transfer`. */
    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "wrong owner");
        require(to != address(0), "use burn");
        _move(from, to, tokenId);
    }

    /** To the zero address, so `burn`. Note 0x…dEaD is NOT a burn to this indexer. */
    function burn(uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(owner != address(0), "no such token");
        _move(owner, address(0), tokenId);
    }

    function _move(address from, address to, uint256 tokenId) internal {
        balanceOf[from] -= 1;
        if (to != address(0)) {
            balanceOf[to] += 1;
        }
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
