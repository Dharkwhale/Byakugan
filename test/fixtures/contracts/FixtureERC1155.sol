// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Deliberately minimal ERC-1155 for Byakugan's deterministic integration fixture.
 *
 * Its reason for existing is `mintBatch`: ONE `TransferBatch` log carrying several
 * ids and values. That single shape is what the `batch_index` primary-key column
 * exists for, and it is the bug this project already shipped once — the original
 * key could not hold more than one token per batch log, so every token after the
 * first collided and batch mints were silently undercounted.
 *
 * A compliant chain rarely hands you an interesting batch on demand, which is the
 * whole argument for a fixture: `mintBatch` is called with ids and amounts chosen to
 * be awkward on purpose (see the README's recommended calls) rather than whatever a
 * real collection happened to do.
 *
 * Self-contained, no imports, no safeTransfer callbacks, no URI machinery.
 */
contract FixtureERC1155 {
    event TransferSingle(
        address indexed operator, address indexed from, address indexed to,
        uint256 id, uint256 value
    );
    event TransferBatch(
        address indexed operator, address indexed from, address indexed to,
        uint256[] ids, uint256[] values
    );

    mapping(uint256 => mapping(address => uint256)) public balanceOf;

    /** `0xffffffff` MUST answer false — see the note in FixtureERC721. */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        if (interfaceId == 0xffffffff) return false;
        return interfaceId == 0x01ffc9a7    // ERC-165
            || interfaceId == 0xd9b67a26;   // ERC-1155
    }

    /** One id, one log: the TransferSingle path. */
    function mint(address to, uint256 id, uint256 amount) external {
        require(to != address(0), "mint to zero");
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
    }

    /**
     * Several ids in ONE log: the TransferBatch path.
     *
     * Reverts on a length mismatch rather than zipping the shorter array, matching
     * what the decoder is specified to do with a malformed batch. A compliant
     * contract cannot emit the mismatched shape, which is why that case is tested
     * against a programmatically encoded fixture instead of against this.
     */
    function mintBatch(
        address to, uint256[] calldata ids, uint256[] calldata amounts
    ) external {
        require(to != address(0), "mint to zero");
        require(ids.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < ids.length; i++) {
            balanceOf[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, address(0), to, ids, amounts);
    }

    /** An empty batch: a valid log carrying zero movements. Must decode to no rows. */
    function mintEmptyBatch(address to) external {
        uint256[] memory ids;
        uint256[] memory amounts;
        emit TransferBatch(msg.sender, address(0), to, ids, amounts);
    }

    function transferFrom(address from, address to, uint256 id, uint256 amount) external {
        require(to != address(0), "use burn");
        balanceOf[id][from] -= amount;
        balanceOf[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function burn(uint256 id, uint256 amount) external {
        balanceOf[id][msg.sender] -= amount;
        emit TransferSingle(msg.sender, msg.sender, address(0), id, amount);
    }
}
