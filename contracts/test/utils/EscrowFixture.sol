// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BonaFideEscrow} from "../../src/BonaFideEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

abstract contract EscrowFixture is Test {
    address internal constant FORFEIT_SINK = 0x000000000000000000000000000000000000dEaD;
    uint64 internal constant BINDING_DELAY = 1 days;
    uint256 internal constant MAX_AMOUNT = 50e6;
    bytes32 internal constant REPO = keccak256("github:tonymorony/lottie-squeeze");
    uint64 internal constant START = 1_000_000;
    uint64 internal constant PR7_DEADLINE = START + 1 days + 14 days;
    bytes32 internal constant SALT = bytes32(uint256(1));

    MockUSDC internal usdc;
    BonaFideEscrow internal escrow;
    address internal keeper = makeAddr("keeper");
    address internal maintainer;
    uint256 internal maintainerPk;
    address internal contributor = makeAddr("contributor");

    function setUp() public virtual {
        (maintainer, maintainerPk) = makeAddrAndKey("maintainer");
        usdc = new MockUSDC();
        escrow = new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);
        vm.warp(START);
        usdc.mint(contributor, 100e6);
        vm.prank(contributor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _funded(string memory name) internal returns (address who) {
        who = makeAddr(name);
        usdc.mint(who, 100e6);
        vm.prank(who);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _signer(string memory name) internal returns (address who, uint256 pk) {
        (who, pk) = makeAddrAndKey(name);
        usdc.mint(who, 100e6);
    }

    function _activate(address maintainer_, uint16 forfeitBps, uint32 timeout, uint256 amount) internal {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer_, forfeitBps, timeout, amount);
        vm.warp(vm.getBlockTimestamp() + BINDING_DELAY);
        escrow.activateRepo(REPO);
    }

    function _depositPR7() internal returns (bytes32 key) {
        _activate(maintainer, 5000, 14 days, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        return escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function _signForfeit(uint256 pk, bytes32 key, uint256 serial, uint256 sigDeadline)
        internal
        view
        returns (bytes memory)
    {
        return _signForfeitAt(escrow, pk, key, serial, sigDeadline);
    }

    function _signForfeitAt(BonaFideEscrow target, uint256 pk, bytes32 key, uint256 serial, uint256 sigDeadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BonaFide"),
                keccak256("1"),
                block.chainid,
                address(target)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)"), key, serial, sigDeadline)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _nonce(bytes32 key, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, salt));
    }

    function _signReceive(
        uint256 pk,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            pk, _receiveDigest(from, address(escrow), value, validAfter, validBefore, nonce)
        );
        return abi.encodePacked(r, s, v);
    }

    function _receiveDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                block.chainid,
                address(usdc)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                ),
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
