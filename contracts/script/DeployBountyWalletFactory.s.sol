// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyWalletFactory} from "../src/BountyWalletFactory.sol";

contract DeployBountyWalletFactory is Script {
    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;

    error MainnetNotConfirmed();

    function run() external returns (BountyWalletFactory) {
        return deploy(
            IERC20(vm.envAddress("USDC")),
            vm.envAddress("KEEPER"),
            keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256("yes")
        );
    }

    function deploy(IERC20 usdc, address keeper, bool mainnetConfirmed) public returns (BountyWalletFactory factory) {
        if (block.chainid == ARC_MAINNET_CHAIN_ID && !mainnetConfirmed) revert MainnetNotConfirmed();
        vm.startBroadcast();
        factory = new BountyWalletFactory(usdc, keeper);
        vm.stopBroadcast();

        console.log("chain id              ", block.chainid);
        console.log("bounty wallet factory ", address(factory));
        console.log("usdc                  ", address(usdc));
        console.log("keeper                ", keeper);
        console.log("wallet init code hash ", vm.toString(factory.walletInitCodeHash()));
    }
}
