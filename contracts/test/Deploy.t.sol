// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BonaFideEscrow} from "../src/BonaFideEscrow.sol";
import {CharityRouter} from "../src/CharityRouter.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";

contract DeployTest is Test {
    IERC20 internal constant ARC_USDC = IERC20(0x3600000000000000000000000000000000000000);
    uint32 internal constant BASE = 6;
    bytes32 internal constant FUND = 0x000000000000000000000000000000000000000000000000000000000000f00d;

    Deploy internal script;
    MockTokenMessengerV2 internal messenger;
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        script = new Deploy();
        messenger = new MockTokenMessengerV2();
        messenger.addRemoteTokenMessenger(BASE, bytes32(uint256(uint160(address(messenger)))));
    }

    function test_deploy_onArcTestnetDeploysTheRouterAndAnEscrowThatForfeitsToIt() public {
        vm.chainId(5042002);

        (CharityRouter router, BonaFideEscrow escrow) = script.deploy(_params(keeper), false);

        assertEq(address(router.usdc()), address(ARC_USDC));
        assertEq(address(router.messenger()), address(messenger));
        assertEq(router.destinationDomain(), BASE);
        assertEq(router.mintRecipient(), FUND);
        assertEq(address(escrow.usdc()), address(ARC_USDC));
        assertEq(escrow.keeper(), keeper);
        assertEq(escrow.forfeitSink(), address(router));
        assertEq(escrow.bindingDelay(), 86400);
        assertEq(escrow.maxAmount(), 50e6);
    }

    function test_deploy_createsTheRouterFirst() public {
        uint64 nonce = vm.getNonce(DEFAULT_SENDER);

        (CharityRouter router, BonaFideEscrow escrow) = script.deploy(_params(keeper), false);

        assertEq(address(router), vm.computeCreateAddress(DEFAULT_SENDER, nonce));
        assertEq(address(escrow), vm.computeCreateAddress(DEFAULT_SENDER, nonce + 1));
    }

    function test_deploy_revertsWhenTheKeeperIsTheRouter() public {
        address routerAddress = vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER));

        vm.expectRevert(BonaFideEscrow.ForfeitSinkIsKeeper.selector);
        script.deploy(_params(routerAddress), false);
    }

    function test_deploy_revertsWhenTheMessengerDoesNotRouteToTheDomain() public {
        Deploy.Params memory p = _params(keeper);
        p.destinationDomain = 26;

        vm.expectRevert(CharityRouter.UnsupportedDomain.selector);
        script.deploy(p, false);
    }

    function test_deploy_onArcMainnetRevertsWithoutConfirmation() public {
        vm.chainId(5042);

        vm.expectRevert(Deploy.MainnetNotConfirmed.selector);
        script.deploy(_params(keeper), false);
    }

    function test_deploy_onArcMainnetProceedsWithConfirmation() public {
        vm.chainId(5042);

        (, BonaFideEscrow escrow) = script.deploy(_params(keeper), true);

        assertEq(escrow.keeper(), keeper);
    }

    function test_parseRecipient_leftPadsAnAddress() public view {
        assertEq(
            script.parseRecipient("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"),
            0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa
        );
    }

    function test_parseRecipient_keepsA32ByteValue() public view {
        assertEq(
            script.parseRecipient("0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893"),
            0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893
        );
    }

    function test_parseRecipient_rejectsAnyOtherLength() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.InvalidRecipient.selector, "0xf00d"));
        script.parseRecipient("0xf00d");
    }

    function _params(address keeper_) internal view returns (Deploy.Params memory) {
        return Deploy.Params({
            usdc: ARC_USDC,
            keeper: keeper_,
            messenger: messenger,
            destinationDomain: BASE,
            forfeitRecipient: FUND,
            bindingDelay: 86400,
            maxAmount: 50e6
        });
    }
}
