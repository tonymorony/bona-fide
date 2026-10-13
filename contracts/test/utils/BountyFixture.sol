// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BountyWallet} from "../../src/BountyWallet.sol";
import {BountyWalletFactory} from "../../src/BountyWalletFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

abstract contract BountyFixture is Test {
    bytes32 internal constant REPO = keccak256("github:tonymorony/lottie-squeeze");
    uint64 internal constant START = 1_000_000;
    uint256 internal constant PER_PAYOUT = 100e6;
    uint256 internal constant PERIOD_LIMIT = 250e6;
    uint32 internal constant PERIOD = 7 days;
    uint256 internal constant FUNDED = 500e6;

    MockUSDC internal usdc;
    BountyWalletFactory internal factory;
    BountyWallet internal wallet;
    address internal keeper = makeAddr("keeper");
    address internal maintainer;
    uint256 internal maintainerPk;
    address internal contributor = makeAddr("contributor");

    function setUp() public virtual {
        (maintainer, maintainerPk) = makeAddrAndKey("maintainer");
        usdc = new MockUSDC();
        factory = new BountyWalletFactory(usdc, keeper);
        vm.warp(START);
        wallet = _create(maintainer, REPO);
        usdc.mint(maintainer, 1000e6);
        vm.startPrank(maintainer);
        usdc.approve(address(wallet), type(uint256).max);
        wallet.fund(FUNDED);
        vm.stopPrank();
    }

    function _create(address owner, bytes32 repoId) internal returns (BountyWallet) {
        vm.prank(owner);
        return factory.create(repoId, PER_PAYOUT, PERIOD_LIMIT, PERIOD);
    }

    function _post(uint64 issueNumber, uint256 amount) internal returns (uint64 serial) {
        vm.prank(maintainer);
        wallet.postBounty(issueNumber, amount);
        return wallet.bountyOf(issueNumber).serial;
    }

    function _keeperPay(uint64 issueNumber, address payee) internal {
        vm.prank(keeper);
        wallet.keeperPay(issueNumber, payee);
    }

    function _signPayout(
        uint256 pk,
        uint64 issueNumber,
        uint256 serial,
        address payee,
        uint256 amount,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return _signPayoutAt(wallet, pk, issueNumber, serial, payee, amount, deadline);
    }

    function _signPayoutAt(
        BountyWallet target,
        uint256 pk,
        uint64 issueNumber,
        uint256 serial,
        address payee,
        uint256 amount,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _payoutDigest(address(target), issueNumber, serial, payee, amount, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _payoutDigest(
        address target,
        uint64 issueNumber,
        uint256 serial,
        address payee,
        uint256 amount,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BonaFide Bounty"),
                keccak256("1"),
                block.chainid,
                target
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)"),
                uint256(issueNumber),
                serial,
                payee,
                amount,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signReceive(
        uint256 pk,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }
}
