// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BountyWallet} from "../src/BountyWallet.sol";
import {BountyWalletFactory} from "../src/BountyWalletFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {BountyFixture} from "./utils/BountyFixture.sol";

contract BountyWalletFactoryTest is BountyFixture {
    function test_constructor_storesParameters() public view {
        assertEq(address(factory.usdc()), address(usdc));
        assertEq(factory.keeper(), keeper);
        assertEq(factory.walletInitCodeHash(), keccak256(type(BountyWallet).creationCode));
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(BountyWalletFactory.ZeroAddress.selector);
        new BountyWalletFactory(MockUSDC(address(0)), keeper);
    }

    function test_constructor_revertsOnZeroKeeper() public {
        vm.expectRevert(BountyWalletFactory.ZeroAddress.selector);
        new BountyWalletFactory(usdc, address(0));
    }

    function test_create_deploysTheCallersWalletAtThePredictedAddress() public {
        (address owner,) = makeAddrAndKey("otherMaintainer");
        bytes32 repoId = keccak256("github:tonymorony/other");
        address predicted = factory.predict(repoId, owner);
        assertEq(factory.walletOf(repoId, owner), address(0));

        vm.expectEmit(predicted);
        emit BountyWallet.LimitsSet(PER_PAYOUT, PERIOD_LIMIT, PERIOD);
        vm.expectEmit(predicted);
        emit BountyWallet.KeeperEnabled(true);
        vm.expectEmit(address(factory));
        emit BountyWalletFactory.WalletCreated(repoId, owner, predicted);
        BountyWallet w = _create(owner, repoId);

        assertEq(address(w), predicted);
        assertEq(factory.walletOf(repoId, owner), predicted);
        assertEq(w.factory(), address(factory));
        assertEq(address(w.usdc()), address(usdc));
        assertEq(w.keeper(), keeper);
        assertEq(w.repoId(), repoId);
        assertEq(w.owner(), owner);
        assertEq(w.perPayoutLimit(), PER_PAYOUT);
        assertEq(w.periodLimit(), PERIOD_LIMIT);
        assertEq(w.periodLength(), PERIOD);
        assertTrue(w.keeperEnabled());
        assertEq(w.reserved(), 0);
    }

    function test_create_revertsWhenTheCallerAlreadyHasAWalletForTheRepo() public {
        vm.expectRevert(BountyWalletFactory.WalletExists.selector);
        _create(maintainer, REPO);
    }

    function test_create_anotherOwnerOrRepoGetsAnotherWallet() public {
        BountyWallet otherRepo = _create(maintainer, keccak256("github:tonymorony/other"));
        BountyWallet otherOwner = _create(makeAddr("squatter"), REPO);

        assertTrue(address(otherRepo) != address(wallet));
        assertTrue(address(otherOwner) != address(wallet));
        assertEq(factory.walletOf(REPO, maintainer), address(wallet));
        assertEq(otherOwner.owner(), makeAddr("squatter"));
    }

    function test_create_revertsWhenTheKeeperWouldOwnTheWallet() public {
        vm.expectRevert(BountyWallet.OwnerIsKeeper.selector);
        _create(keeper, REPO);
    }

    function test_create_revertsOnPeriodLengthOutOfBounds() public {
        vm.startPrank(maintainer);
        vm.expectRevert(BountyWallet.InvalidPeriodLength.selector);
        factory.create(keccak256("a"), PER_PAYOUT, PERIOD_LIMIT, 1 hours - 1);
        vm.expectRevert(BountyWallet.InvalidPeriodLength.selector);
        factory.create(keccak256("b"), PER_PAYOUT, PERIOD_LIMIT, 365 days + 1);
        BountyWallet low = factory.create(keccak256("c"), 0, 0, 1 hours);
        BountyWallet high = factory.create(keccak256("d"), type(uint256).max, type(uint256).max, 365 days);
        vm.stopPrank();

        assertEq(low.periodLength(), 1 hours);
        assertEq(high.periodLength(), 365 days);
    }

    function test_create_fundsSentToThePredictedAddressBeforehandAreAvailable() public {
        bytes32 repoId = keccak256("github:tonymorony/other");
        address predicted = factory.predict(repoId, maintainer);
        usdc.mint(predicted, 7e6);

        BountyWallet w = _create(maintainer, repoId);

        assertEq(w.available(), 7e6);
    }

    function test_saltOf_isTheAbiEncodedRepoAndOwner() public view {
        assertEq(factory.saltOf(REPO, maintainer), keccak256(abi.encode(REPO, maintainer)));
    }

    function test_parameters_areEmptyOutsideCreate() public view {
        (bytes32 repoId, address owner, uint256 perPayout, uint256 periodLimit, uint32 periodLength) =
            factory.parameters();
        assertEq(repoId, bytes32(0));
        assertEq(owner, address(0));
        assertEq(perPayout + periodLimit + periodLength, 0);
    }

    function test_wallet_cannotBeDeployedOutsideTheFactory() public {
        vm.expectRevert();
        new BountyWallet();
    }
}
