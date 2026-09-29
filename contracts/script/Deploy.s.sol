// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BonaFideEscrow} from "../src/BonaFideEscrow.sol";
import {CharityRouter} from "../src/CharityRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";

contract Deploy is Script {
    struct Params {
        IERC20 usdc;
        address keeper;
        ITokenMessengerV2 messenger;
        uint32 destinationDomain;
        bytes32 forfeitRecipient;
        uint64 bindingDelay;
        uint256 maxAmount;
    }

    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;
    uint256 public constant DEFAULT_BINDING_DELAY = 86400;
    uint256 public constant DEFAULT_MAX_AMOUNT = 50e6;

    error MainnetNotConfirmed();
    error InvalidRecipient(string value);

    function run() external returns (CharityRouter, BonaFideEscrow) {
        return deploy(
            Params({
                usdc: IERC20(vm.envAddress("USDC")),
                keeper: vm.envAddress("KEEPER"),
                messenger: ITokenMessengerV2(vm.envAddress("CCTP_MESSENGER")),
                destinationDomain: SafeCast.toUint32(vm.envUint("DEST_DOMAIN")),
                forfeitRecipient: parseRecipient(vm.envString("FORFEIT_RECIPIENT")),
                bindingDelay: SafeCast.toUint64(vm.envOr("BINDING_DELAY", DEFAULT_BINDING_DELAY)),
                maxAmount: vm.envOr("MAX_AMOUNT", DEFAULT_MAX_AMOUNT)
            }),
            keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256("yes")
        );
    }

    function deploy(Params memory p, bool mainnetConfirmed)
        public
        returns (CharityRouter router, BonaFideEscrow escrow)
    {
        if (block.chainid == ARC_MAINNET_CHAIN_ID && !mainnetConfirmed) revert MainnetNotConfirmed();
        vm.startBroadcast();
        router = new CharityRouter(p.usdc, p.messenger, p.destinationDomain, p.forfeitRecipient);
        escrow = new BonaFideEscrow(p.usdc, p.keeper, address(router), p.bindingDelay, p.maxAmount);
        vm.stopBroadcast();

        console.log("chain id         ", block.chainid);
        console.log("charity router   ", address(router));
        console.log("cctp messenger   ", address(p.messenger));
        console.log("dest domain      ", p.destinationDomain);
        console.log("forfeit recipient", vm.toString(p.forfeitRecipient));
        console.log("escrow           ", address(escrow));
        console.log("usdc             ", address(p.usdc));
        console.log("keeper           ", p.keeper);
        console.log("binding delay    ", p.bindingDelay);
        console.log("max amount       ", p.maxAmount);
    }

    /// @notice FORFEIT_RECIPIENT is an EVM address, left-padded as CCTP expects, or a raw bytes32 for a non-EVM
    /// domain (on Solana, the recipient's USDC token account).
    function parseRecipient(string memory value) public pure returns (bytes32) {
        uint256 length = bytes(value).length;
        if (length == 42) return bytes32(uint256(uint160(vm.parseAddress(value))));
        if (length == 66) return vm.parseBytes32(value);
        revert InvalidRecipient(value);
    }
}
