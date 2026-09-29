// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowFixture} from "./utils/EscrowFixture.sol";

contract MockUSDCTest is EscrowFixture {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function test_eip712_matchesArcUsdcOnTestnetAndMainnet() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        MockUSDC arcUsdc = MockUSDC(ARC_USDC);

        assertEq(
            arcUsdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
        );
        vm.chainId(5042002);
        assertEq(arcUsdc.DOMAIN_SEPARATOR(), 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0);
        vm.chainId(5042);
        assertEq(arcUsdc.DOMAIN_SEPARATOR(), 0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84);
    }

    function test_receiveWithAuthorization_acceptsSplitAndPackedSignatures() public {
        (address from, uint256 pk) = _signer("from");
        uint256 validBefore = block.timestamp + 1 hours;

        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _receiveDigest(from, address(this), 1e6, 0, validBefore, bytes32("split")));
        usdc.receiveWithAuthorization(from, address(this), 1e6, 0, validBefore, bytes32("split"), v, r, s);
        (v, r, s) = vm.sign(pk, _receiveDigest(from, address(this), 2e6, 0, validBefore, bytes32("packed")));
        usdc.receiveWithAuthorization(
            from, address(this), 2e6, 0, validBefore, bytes32("packed"), abi.encodePacked(r, s, v)
        );

        assertEq(usdc.balanceOf(address(this)), 3e6);
        assertTrue(usdc.authorizationState(from, bytes32("split")));
        assertTrue(usdc.authorizationState(from, bytes32("packed")));
    }
}
