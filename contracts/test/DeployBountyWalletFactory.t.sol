// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyWallet} from "../src/BountyWallet.sol";
import {BountyWalletFactory} from "../src/BountyWalletFactory.sol";
import {DeployBountyWalletFactory} from "../script/DeployBountyWalletFactory.s.sol";

contract DeployBountyWalletFactoryTest is Test {
    IERC20 internal constant ARC_USDC = IERC20(0x3600000000000000000000000000000000000000);

    DeployBountyWalletFactory internal script;
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        script = new DeployBountyWalletFactory();
    }

    function test_deploy_onArcTestnetDeploysTheFactoryWithTheKeeper() public {
        vm.chainId(5042002);
        uint64 nonce = vm.getNonce(DEFAULT_SENDER);

        BountyWalletFactory factory = script.deploy(ARC_USDC, keeper, false);

        assertEq(address(factory), vm.computeCreateAddress(DEFAULT_SENDER, nonce));
        assertEq(address(factory.usdc()), address(ARC_USDC));
        assertEq(factory.keeper(), keeper);
        assertEq(factory.walletInitCodeHash(), keccak256(type(BountyWallet).creationCode));
    }

    function test_deploy_revertsOnAZeroKeeper() public {
        vm.expectRevert(BountyWalletFactory.ZeroAddress.selector);
        script.deploy(ARC_USDC, address(0), false);
    }

    function test_deploy_onArcMainnetRevertsWithoutConfirmation() public {
        vm.chainId(5042);

        vm.expectRevert(DeployBountyWalletFactory.MainnetNotConfirmed.selector);
        script.deploy(ARC_USDC, keeper, false);
    }

    function test_deploy_onArcMainnetProceedsWithConfirmation() public {
        vm.chainId(5042);

        BountyWalletFactory factory = script.deploy(ARC_USDC, keeper, true);

        assertEq(factory.keeper(), keeper);
    }

    function test_run_readsUsdcKeeperAndTheMainnetGuardFromTheEnvironment() public {
        vm.chainId(5042);
        vm.setEnv("USDC", vm.toString(address(ARC_USDC)));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("CONFIRM_MAINNET", "no");
        vm.expectRevert(DeployBountyWalletFactory.MainnetNotConfirmed.selector);
        script.run();

        vm.setEnv("CONFIRM_MAINNET", "yes");
        BountyWalletFactory factory = script.run();

        assertEq(factory.keeper(), keeper);
        assertEq(address(factory.usdc()), address(ARC_USDC));
    }
}
