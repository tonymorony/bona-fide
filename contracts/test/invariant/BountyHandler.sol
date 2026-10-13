// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BountyWallet} from "../../src/BountyWallet.sol";
import {BountyWalletFactory} from "../../src/BountyWalletFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";

contract BountyHandler is Test {
    struct Model {
        uint256 amount;
        uint64 serial;
        BountyWallet.Status status;
        address payee;
    }

    struct Limits {
        uint256 perPayout;
        uint256 periodLimit;
        uint32 periodLength;
        uint64 periodStart;
        uint256 spent;
        bool keeperEnabled;
    }

    struct Signed {
        uint256 walletIndex;
        uint64 issueNumber;
        uint64 serial;
        address payee;
        uint256 amount;
        uint256 deadline;
        bytes signature;
    }

    struct Stats {
        uint256 funds;
        uint256 posts;
        uint256 cancels;
        uint256 keeperPays;
        uint256 keeperPaysWhileDisabled;
        uint256 keeperPaysNotOpen;
        uint256 keeperPaysAboveLimit;
        uint256 keeperPaysToInvalidPayee;
        uint256 signaturePays;
        uint256 ownerPays;
        uint256 withdrawals;
        uint256 limitChanges;
        uint256 switches;
        uint256 replayAttempts;
        uint256 forgedAttempts;
        uint256 strangerAttempts;
        uint256 warps;
    }

    uint64 public constant ISSUES = 12;

    MockUSDC public immutable usdc;
    BountyWalletFactory public immutable factory;
    address public immutable keeper;
    uint256 internal immutable keeperPk;

    BountyWallet[] internal wallets;
    address[] internal owners;
    mapping(address owner => uint256) internal ownerKey;
    address[] internal funders;
    address[] internal payees;
    address[] internal withdrawTargets;
    address[] internal relayers;
    address[] internal tracked;

    mapping(uint256 walletIndex => mapping(uint64 issueNumber => Model)) internal model;
    mapping(uint256 walletIndex => Limits) internal limitsModel;
    mapping(uint256 walletIndex => uint256) public balanceModel;
    mapping(uint256 walletIndex => uint64) internal serialModel;
    Signed[] internal signedPayouts;

    mapping(address => uint256) public inflow;
    mapping(address => uint256) public expectedInflow;

    bool public invalidActionAccepted;
    bool public keeperAboveLimit;
    bool public disabledKeeperPaid;
    bool public paidTwice;
    bool public replayAccepted;
    bool public forgedAccepted;
    bool public strangerSucceeded;

    Stats internal stats;

    constructor() {
        usdc = new MockUSDC();
        (keeper, keeperPk) = makeAddrAndKey("keeper");
        factory = new BountyWalletFactory(usdc, keeper);

        (address owner0, uint256 owner0Pk) = makeAddrAndKey("owner0");
        (address safeSigner, uint256 safeSignerPk) = makeAddrAndKey("safeSigner");
        address safe = address(new MockERC1271Wallet(safeSigner));
        ownerKey[owner0] = owner0Pk;
        ownerKey[safe] = safeSignerPk;
        _newWallet(owner0, keccak256("github:owner/repo0"));
        _newWallet(owner0, keccak256("github:owner/repo1"));
        _newWallet(safe, keccak256("github:owner/repo0"));

        for (uint256 i; i < 3; ++i) {
            address f = makeAddr(string.concat("funder", vm.toString(i)));
            usdc.mint(f, 1e15);
            for (uint256 w; w < wallets.length; ++w) {
                vm.prank(f);
                usdc.approve(address(wallets[w]), type(uint256).max);
            }
            funders.push(f);
        }
        for (uint256 i; i < 3; ++i) {
            payees.push(makeAddr(string.concat("payee", vm.toString(i))));
        }
        payees.push(owner0);
        withdrawTargets.push(owner0);
        withdrawTargets.push(safe);
        withdrawTargets.push(makeAddr("cold"));
        relayers.push(makeAddr("relayer0"));
        relayers.push(makeAddr("relayer1"));

        for (uint256 i; i < funders.length; ++i) {
            tracked.push(funders[i]);
        }
        for (uint256 i; i < 3; ++i) {
            tracked.push(payees[i]);
        }
        tracked.push(owner0);
        tracked.push(safe);
        tracked.push(safeSigner);
        tracked.push(makeAddr("cold"));
        tracked.push(relayers[0]);
        tracked.push(relayers[1]);
        tracked.push(keeper);
        tracked.push(address(factory));
        tracked.push(address(this));
    }

    function fund(uint256 walletSeed, uint256 funderSeed, uint256 amount) external {
        uint256 w = walletSeed % wallets.length;
        amount = _bound(amount, 1, 1000e6);
        vm.prank(funders[funderSeed % funders.length]);
        wallets[w].fund(amount);
        balanceModel[w] += amount;
        stats.funds++;
    }

    function donate(uint256 walletSeed, uint256 funderSeed, uint256 amount) external {
        uint256 w = walletSeed % wallets.length;
        amount = _bound(amount, 1, 100e6);
        vm.prank(funders[funderSeed % funders.length]);
        usdc.transfer(address(wallets[w]), amount);
        balanceModel[w] += amount;
        stats.funds++;
    }

    function post(uint256 walletSeed, uint256 issueSeed, uint256 amount) external {
        uint256 w = walletSeed % wallets.length;
        uint64 issue = _pickFreeIssue(w, issueSeed);
        uint256 free = balanceModel[w] - _reservedModel(w);
        if (amount % 5 == 0 || free == 0) amount = _bound(amount, 0, 400e6);
        else amount = _bound(amount, 1, free < 150e6 ? free : 150e6);
        BountyWallet wallet = wallets[w];
        Model storage m = model[w][issue];
        bool valid = m.status != BountyWallet.Status.Open && m.status != BountyWallet.Status.Paid && amount > 0
            && amount <= balanceModel[w] - _reservedModel(w);
        vm.prank(owners[w]);
        if (!valid) {
            try wallet.postBounty(issue, amount) {
                invalidActionAccepted = true;
            } catch {}
            return;
        }
        wallet.postBounty(issue, amount);
        model[w][issue] = Model(amount, ++serialModel[w], BountyWallet.Status.Open, address(0));
        stats.posts++;
    }

    function cancel(uint256 walletSeed, uint256 issueSeed) external {
        uint256 w = walletSeed % wallets.length;
        uint64 issue = uint64(issueSeed % ISSUES);
        Model storage m = model[w][issue];
        vm.prank(owners[w]);
        if (m.status != BountyWallet.Status.Open) {
            try wallets[w].cancelBounty(issue) {
                invalidActionAccepted = true;
            } catch {}
            return;
        }
        wallets[w].cancelBounty(issue);
        m.status = BountyWallet.Status.Cancelled;
        stats.cancels++;
    }

    function keeperPay(uint256 walletSeed, uint256 issueSeed, uint256 payeeSeed) external {
        uint256 w = walletSeed % wallets.length;
        for (uint256 i; i < wallets.length && issueSeed % 5 != 0 && _reservedModel(w) == 0; ++i) {
            w = (w + 1) % wallets.length;
        }
        uint64 issue = _pickIssue(w, issueSeed);
        address payee = _payeeOrInvalid(w, payeeSeed);
        (bool valid, bool newPeriod, uint256 spent) = _keeperMayPay(w, issue, payee);
        if (!valid) {
            _keeperPayRejected(w, issue, payee, spent);
            return;
        }
        BountyWallet wallet = wallets[w];
        uint256 perPayoutOnChain = wallet.perPayoutLimit();
        uint256 periodLimitOnChain = wallet.periodLimit();
        _payAndRecord(w, issue, payee, keeper, abi.encodeCall(BountyWallet.keeperPay, (issue, payee)));
        Limits storage l = limitsModel[w];
        uint256 amount = model[w][issue].amount;
        if (newPeriod) l.periodStart = uint64(block.timestamp);
        l.spent = spent + amount;
        if (amount > perPayoutOnChain || wallet.spentInPeriod() > periodLimitOnChain) keeperAboveLimit = true;
        stats.keeperPays++;
    }

    function payWithSignature(
        uint256 walletSeed,
        uint256 issueSeed,
        uint256 payeeSeed,
        uint256 window,
        uint256 relayerSeed
    ) external {
        uint256 w = walletSeed % wallets.length;
        uint64 issue = _pickIssue(w, issueSeed);
        Model storage m = model[w][issue];
        if (m.status != BountyWallet.Status.Open) return;
        address payee = payees[payeeSeed % payees.length];
        uint256 deadline = block.timestamp + _bound(window, 0, 30 days);
        bytes memory sig = _sign(ownerKey[owners[w]], w, issue, m.serial, payee, m.amount, deadline);
        signedPayouts.push(Signed(w, issue, m.serial, payee, m.amount, deadline, sig));
        if (relayerSeed % 4 == 0) return;
        address relayer = relayerSeed % 4 == 1 ? keeper : relayers[relayerSeed % relayers.length];
        _payAndRecord(
            w, issue, payee, relayer, abi.encodeCall(BountyWallet.payWithSignature, (issue, payee, deadline, sig))
        );
        stats.signaturePays++;
    }

    function replaySignature(uint256 signedSeed, uint256 mutation, uint256 targetSeed) external {
        if (signedPayouts.length == 0) return;
        Signed memory s = signedPayouts[signedSeed % signedPayouts.length];
        mutation = mutation % 4;
        uint256 w = s.walletIndex;
        uint64 issue = s.issueNumber;
        address payee = s.payee;
        if (mutation == 1) w = (s.walletIndex + 1 + targetSeed % (wallets.length - 1)) % wallets.length;
        if (mutation == 2) issue = uint64((s.issueNumber + 1 + targetSeed % (ISSUES - 1)) % ISSUES);
        if (mutation == 3) payee = payees[(_indexOf(payees, s.payee) + 1 + targetSeed % 3) % payees.length];
        Model storage m = model[w][issue];
        bool stillValid = mutation == 0 && m.status == BountyWallet.Status.Open && m.serial == s.serial
            && block.timestamp <= s.deadline;
        if (stillValid) return;
        vm.prank(relayers[targetSeed % relayers.length]);
        try wallets[w].payWithSignature(issue, payee, s.deadline, s.signature) {
            replayAccepted = true;
        } catch {}
        stats.replayAttempts++;
    }

    function forgedSignature(uint256 walletSeed, uint256 issueSeed, uint256 signerSeed) external {
        uint256 w = walletSeed % wallets.length;
        uint64 issue = _pickIssue(w, issueSeed);
        Model storage m = model[w][issue];
        address otherOwner = owners[w] == owners[2] ? owners[0] : owners[2];
        uint256 pk = signerSeed % 2 == 0 ? keeperPk : ownerKey[otherOwner];
        address payee = payees[signerSeed % payees.length];
        bytes memory sig = _sign(pk, w, issue, m.serial, payee, m.amount, block.timestamp);
        vm.prank(keeper);
        try wallets[w].payWithSignature(issue, payee, block.timestamp, sig) {
            forgedAccepted = true;
        } catch {}
        stats.forgedAttempts++;
    }

    function ownerPay(uint256 walletSeed, uint256 issueSeed, uint256 payeeSeed) external {
        uint256 w = walletSeed % wallets.length;
        uint64 issue = _pickIssue(w, issueSeed);
        if (model[w][issue].status != BountyWallet.Status.Open) return;
        address payee = payees[payeeSeed % payees.length];
        _payAndRecord(w, issue, payee, owners[w], abi.encodeCall(BountyWallet.ownerPay, (issue, payee)));
        stats.ownerPays++;
    }

    function withdraw(uint256 walletSeed, uint256 targetSeed, uint256 amount) external {
        uint256 w = walletSeed % wallets.length;
        address to = withdrawTargets[targetSeed % withdrawTargets.length];
        uint256 free = balanceModel[w] - _reservedModel(w);
        amount = _bound(amount, 1, free + 10e6);
        BountyWallet wallet = wallets[w];
        if (amount > free) {
            vm.prank(owners[w]);
            try wallet.withdraw(to, amount) {
                invalidActionAccepted = true;
            } catch {}
            return;
        }
        uint256[] memory before = _balances();
        vm.prank(owners[w]);
        wallet.withdraw(to, amount);
        _recordInflows(before);
        balanceModel[w] -= amount;
        expectedInflow[to] += amount;
        stats.withdrawals++;
    }

    function setLimits(uint256 walletSeed, uint256 perPayout, uint256 periodLimit, uint256 periodLength) external {
        uint256 w = walletSeed % wallets.length;
        Limits storage l = limitsModel[w];
        l.perPayout = _bound(perPayout, 0, 300e6);
        l.periodLimit = _bound(periodLimit, 0, 600e6);
        l.periodLength = uint32(_bound(periodLength, 1 hours, 30 days));
        vm.prank(owners[w]);
        wallets[w].setLimits(l.perPayout, l.periodLimit, l.periodLength);
        stats.limitChanges++;
    }

    function setKeeperEnabled(uint256 walletSeed, uint256 enabledSeed) external {
        uint256 w = walletSeed % wallets.length;
        bool enabled = enabledSeed % 6 != 0;
        vm.prank(owners[w]);
        wallets[w].setKeeperEnabled(enabled);
        limitsModel[w].keeperEnabled = enabled;
        stats.switches++;
    }

    function strangerActs(uint256 walletSeed, uint256 action, uint256 callerSeed, uint256 issueSeed) external {
        uint256 w = walletSeed % wallets.length;
        BountyWallet wallet = wallets[w];
        uint64 issue = uint64(issueSeed % ISSUES);
        address caller = callerSeed % 3 == 0 ? keeper : relayers[callerSeed % relayers.length];
        if (callerSeed % 3 == 1) caller = owners[(w + 2) % wallets.length];
        if (caller == owners[w]) return;
        bytes memory call;
        action = action % 7;
        if (action == 0) call = abi.encodeCall(wallet.postBounty, (issue, 1));
        else if (action == 1) call = abi.encodeCall(wallet.cancelBounty, (issue));
        else if (action == 2) call = abi.encodeCall(wallet.withdraw, (caller, 1));
        else if (action == 3) call = abi.encodeCall(wallet.setLimits, (type(uint256).max, type(uint256).max, 1 hours));
        else if (action == 4) call = abi.encodeCall(wallet.setKeeperEnabled, (true));
        else if (action == 5) call = abi.encodeCall(wallet.ownerPay, (issue, caller));
        else call = abi.encodeCall(wallet.keeperPay, (issue, caller));
        if (action == 6 && caller == keeper) return;
        vm.prank(caller);
        (bool ok,) = address(wallet).call(call);
        if (ok) strangerSucceeded = true;
        stats.strangerAttempts++;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + _bound(secs, 0, 3 days));
        stats.warps++;
    }

    function statsSnapshot() external view returns (Stats memory) {
        return stats;
    }

    function walletCount() external view returns (uint256) {
        return wallets.length;
    }

    function walletAt(uint256 i) external view returns (BountyWallet) {
        return wallets[i];
    }

    function bountyModel(uint256 w, uint64 issue) external view returns (Model memory) {
        return model[w][issue];
    }

    function limits(uint256 w) external view returns (Limits memory) {
        return limitsModel[w];
    }

    function reservedModel(uint256 w) external view returns (uint256) {
        return _reservedModel(w);
    }

    function trackedAddresses() external view returns (address[] memory) {
        return tracked;
    }

    function allRelayers() external view returns (address[] memory) {
        return relayers;
    }

    function _newWallet(address owner, bytes32 repoId) internal {
        vm.prank(owner);
        wallets.push(factory.create(repoId, 100e6, 250e6, 7 days));
        owners.push(owner);
        limitsModel[wallets.length - 1] = Limits(100e6, 250e6, 7 days, 0, 0, true);
    }

    function _keeperMayPay(uint256 w, uint64 issue, address payee)
        internal
        view
        returns (bool valid, bool newPeriod, uint256 spent)
    {
        Model storage m = model[w][issue];
        Limits storage l = limitsModel[w];
        newPeriod = block.timestamp >= uint256(l.periodStart) + l.periodLength;
        spent = newPeriod ? 0 : l.spent;
        valid = l.keeperEnabled && m.status == BountyWallet.Status.Open && m.amount <= l.perPayout
            && spent + m.amount <= l.periodLimit && _validRecipient(w, payee);
    }

    function _keeperPayRejected(uint256 w, uint64 issue, address payee, uint256 spent) internal {
        Model storage m = model[w][issue];
        Limits storage l = limitsModel[w];
        vm.prank(keeper);
        try wallets[w].keeperPay(issue, payee) {
            if (!l.keeperEnabled) disabledKeeperPaid = true;
            else if (m.status != BountyWallet.Status.Open) paidTwice = true;
            else if (m.amount > l.perPayout || spent + m.amount > l.periodLimit) keeperAboveLimit = true;
            else invalidActionAccepted = true;
        } catch {}
        if (!l.keeperEnabled) stats.keeperPaysWhileDisabled++;
        else if (m.status != BountyWallet.Status.Open) stats.keeperPaysNotOpen++;
        else if (m.amount > l.perPayout || spent + m.amount > l.periodLimit) stats.keeperPaysAboveLimit++;
        else stats.keeperPaysToInvalidPayee++;
    }

    function _payAndRecord(uint256 w, uint64 issue, address payee, address caller, bytes memory call) internal {
        Model storage m = model[w][issue];
        uint256[] memory before = _balances();
        vm.prank(caller);
        (bool ok, bytes memory err) = address(wallets[w]).call(call);
        if (!ok) {
            assembly {
                revert(add(err, 0x20), mload(err))
            }
        }
        _recordInflows(before);
        m.status = BountyWallet.Status.Paid;
        m.payee = payee;
        balanceModel[w] -= m.amount;
        expectedInflow[payee] += m.amount;
    }

    function _reservedModel(uint256 w) internal view returns (uint256 sum) {
        for (uint64 i; i < ISSUES; ++i) {
            if (model[w][i].status == BountyWallet.Status.Open) sum += model[w][i].amount;
        }
    }

    function _validRecipient(uint256 w, address to) internal view returns (bool) {
        return to != address(0) && to != address(wallets[w]) && to != keeper;
    }

    function _payeeOrInvalid(uint256 w, uint256 seed) internal view returns (address) {
        uint256 i = seed % (payees.length + 9);
        if (i < payees.length) return payees[i];
        if (i == payees.length) return keeper;
        if (i == payees.length + 1) return address(wallets[w]);
        if (i == payees.length + 2) return address(0);
        return payees[seed % payees.length];
    }

    function _pickFreeIssue(uint256 w, uint256 seed) internal view returns (uint64) {
        uint64 start = uint64(seed % ISSUES);
        if (seed % 5 == 0) return start;
        for (uint64 i; i < ISSUES; ++i) {
            uint64 issue = (start + i) % ISSUES;
            BountyWallet.Status status = model[w][issue].status;
            if (status == BountyWallet.Status.None || status == BountyWallet.Status.Cancelled) return issue;
        }
        return start;
    }

    function _pickIssue(uint256 w, uint256 seed) internal view returns (uint64) {
        uint64 start = uint64(seed % ISSUES);
        if (seed % 5 == 0) return start;
        for (uint64 i; i < ISSUES; ++i) {
            uint64 issue = (start + i) % ISSUES;
            if (model[w][issue].status == BountyWallet.Status.Open) return issue;
        }
        return start;
    }

    function _sign(uint256 pk, uint256 w, uint64 issue, uint64 serial, address payee, uint256 amount, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BonaFide Bounty"),
                keccak256("1"),
                block.chainid,
                address(wallets[w])
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)"),
                uint256(issue),
                uint256(serial),
                payee,
                amount,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _balances() internal view returns (uint256[] memory b) {
        b = new uint256[](tracked.length);
        for (uint256 i; i < tracked.length; ++i) {
            b[i] = usdc.balanceOf(tracked[i]);
        }
    }

    function _recordInflows(uint256[] memory before) internal {
        for (uint256 i; i < tracked.length; ++i) {
            uint256 nowBalance = usdc.balanceOf(tracked[i]);
            if (nowBalance > before[i]) inflow[tracked[i]] += nowBalance - before[i];
        }
    }

    function _indexOf(address[] storage list, address who) internal view returns (uint256) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) return i;
        }
        revert("unreachable");
    }
}
