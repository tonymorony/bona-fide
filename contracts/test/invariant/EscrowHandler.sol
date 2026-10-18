// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BonaFideEscrow} from "../../src/BonaFideEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";

contract EscrowHandler is Test {
    struct Config {
        address maintainer;
        uint16 forfeitBps;
        uint32 timeout;
        uint256 amount;
    }

    struct Model {
        address depositor;
        address maintainer;
        uint16 forfeitBps;
        uint64 deadline;
        uint64 serial;
        uint256 amount;
        BonaFideEscrow.Status status;
    }

    struct Authorization {
        bytes32 repoId;
        BonaFideEscrow.Kind kind;
        uint64 number;
        address from;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        bytes signature;
    }

    struct Stats {
        uint256 proposals;
        uint256 activations;
        uint256 earlyActivationAttempts;
        uint256 deposits;
        uint256 rejectedDeposits;
        uint256 keeperRefunds;
        uint256 refundsAfterDeadline;
        uint256 earlyRefundAttempts;
        uint256 forfeits;
        uint256 lateForfeitAttempts;
        uint256 keeperForfeitAttempts;
        uint256 replayAttempts;
        uint256 warps;
        uint256 authorizedDeposits;
        uint256 authorizationReuseAttempts;
    }

    uint64 public constant BINDING_DELAY = 1 days;
    uint256 public constant MAX_AMOUNT = 50e6;
    address public constant FORFEIT_SINK = 0x000000000000000000000000000000000000dEaD;

    BonaFideEscrow public immutable escrow;
    MockUSDC public immutable usdc;
    address public immutable keeper;
    uint256 internal immutable keeperPk;

    address[] internal depositors;
    address[] internal relayers;
    address[] internal maintainers;
    address[] internal tracked;
    bytes32[] internal repoIds;
    bytes32[] internal keys;
    mapping(address => uint256) internal signingKey;
    mapping(bytes32 => bool) internal seenKey;

    mapping(bytes32 => Config) internal activeModel;
    mapping(bytes32 => Config) internal pendingModel;
    mapping(bytes32 => uint64) internal effectiveAtModel;
    mapping(bytes32 => Model) public model;
    uint64 internal serialModel;

    mapping(bytes32 => bytes) internal oldSig;
    mapping(bytes32 => uint64) internal oldSigSerial;
    mapping(bytes32 => uint256) internal oldSigDeadline;

    Authorization[] internal usedAuthorizations;
    uint256 internal authorizationCount;

    mapping(address => uint256) public inflow;
    mapping(address => uint256) public expectedInflow;

    bool public forfeitAboveHalf;
    bool public keeperForfeited;
    bool public replayAccepted;
    bool public forfeitAfterDeadline;
    bool public refundAfterDeadlineFailed;
    bool public strangerRefundedEarly;
    bool public resolvedTwice;
    bool public earlyActivation;
    bool public invalidDepositAccepted;

    Stats internal stats;

    constructor() {
        usdc = new MockUSDC();
        (keeper, keeperPk) = makeAddrAndKey("keeper");
        escrow = new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);

        for (uint256 i; i < 4; ++i) {
            (address d, uint256 pk) = makeAddrAndKey(string.concat("depositor", vm.toString(i)));
            depositors.push(d);
            signingKey[d] = pk;
        }
        (address depositorWalletOwner, uint256 depositorWalletOwnerPk) = makeAddrAndKey("depositorWalletOwner");
        address depositorWallet = address(new MockERC1271Wallet(depositorWalletOwner));
        depositors.push(depositorWallet);
        signingKey[depositorWallet] = depositorWalletOwnerPk;
        for (uint256 i; i < depositors.length; ++i) {
            usdc.mint(depositors[i], 1e12);
            vm.prank(depositors[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
        for (uint256 i; i < 3; ++i) {
            (address m, uint256 pk) = makeAddrAndKey(string.concat("maintainer", vm.toString(i)));
            maintainers.push(m);
            signingKey[m] = pk;
        }
        (address walletOwner, uint256 walletOwnerPk) = makeAddrAndKey("walletOwner");
        address wallet = address(new MockERC1271Wallet(walletOwner));
        maintainers.push(wallet);
        signingKey[wallet] = walletOwnerPk;
        relayers.push(makeAddr("relayer0"));
        relayers.push(makeAddr("relayer1"));
        for (uint256 i; i < 3; ++i) {
            repoIds.push(keccak256(abi.encodePacked("github:owner/repo", vm.toString(i))));
        }

        for (uint256 i; i < depositors.length; ++i) {
            tracked.push(depositors[i]);
        }
        for (uint256 i; i < maintainers.length; ++i) {
            tracked.push(maintainers[i]);
        }
        tracked.push(relayers[0]);
        tracked.push(relayers[1]);
        tracked.push(walletOwner);
        tracked.push(depositorWalletOwner);
        tracked.push(keeper);
        tracked.push(FORFEIT_SINK);
        tracked.push(address(this));

        for (uint256 i; i < repoIds.length; ++i) {
            Config memory c = Config(maintainers[i], uint16(2500 * i), uint32((1 + 7 * i) * 1 days), 2e6 * (i + 1));
            vm.prank(keeper);
            escrow.proposeRepo(repoIds[i], c.maintainer, c.forfeitBps, c.timeout, c.amount);
            activeModel[repoIds[i]] = c;
        }
        vm.warp(block.timestamp + BINDING_DELAY);
        for (uint256 i; i < repoIds.length; ++i) {
            escrow.activateRepo(repoIds[i]);
        }
    }

    function propose(uint256 repoSeed, uint256 maintainerSeed, uint256 forfeitBps, uint256 timeout, uint256 amount)
        external
    {
        bytes32 repoId = repoIds[repoSeed % repoIds.length];
        Config memory c = Config(
            maintainers[maintainerSeed % maintainers.length],
            uint16(_bound(forfeitBps, 0, 5000)),
            uint32(_bound(timeout, 1 days, 60 days)),
            _bound(amount, 1, MAX_AMOUNT)
        );
        vm.prank(keeper);
        escrow.proposeRepo(repoId, c.maintainer, c.forfeitBps, c.timeout, c.amount);
        pendingModel[repoId] = c;
        effectiveAtModel[repoId] = uint64(block.timestamp) + BINDING_DELAY;
        stats.proposals++;
    }

    function activate(uint256 repoSeed, uint256 callerSeed) external {
        bytes32 repoId = repoIds[repoSeed % repoIds.length];
        address caller = _anyone(callerSeed);
        bool due = pendingModel[repoId].maintainer != address(0) && block.timestamp >= effectiveAtModel[repoId];
        if (!due) {
            vm.prank(caller);
            try escrow.activateRepo(repoId) {
                earlyActivation = true;
            } catch {}
            stats.earlyActivationAttempts++;
            return;
        }
        vm.prank(caller);
        escrow.activateRepo(repoId);
        activeModel[repoId] = pendingModel[repoId];
        delete pendingModel[repoId];
        delete effectiveAtModel[repoId];
        stats.activations++;
    }

    function deposit(uint256 depositorSeed, uint256 repoSeed, uint256 kindSeed, uint256 numberSeed) external {
        address depositor = depositors[depositorSeed % depositors.length];
        bytes32 repoId = repoIds[repoSeed % repoIds.length];
        BonaFideEscrow.Kind kind = BonaFideEscrow.Kind(kindSeed % 2);
        uint64 number = uint64(_bound(numberSeed, 1, 2));
        bytes32 key = escrow.keyOf(repoId, kind, number);
        Config memory c = activeModel[repoId];
        if (c.maintainer == address(0) || model[key].status == BonaFideEscrow.Status.Active) {
            vm.prank(depositor);
            try escrow.deposit(repoId, kind, number) {
                invalidDepositAccepted = true;
            } catch {}
            stats.rejectedDeposits++;
            return;
        }
        vm.prank(depositor);
        escrow.deposit(repoId, kind, number);
        _modelDeposit(key, depositor, c);
        stats.deposits++;
    }

    function depositWithAuthorization(
        uint256 depositorSeed,
        uint256 repoSeed,
        uint256 kindSeed,
        uint256 numberSeed,
        uint256 callerSeed,
        uint256 windowSeed
    ) external {
        Authorization memory a = _authorize(depositorSeed, repoSeed, kindSeed, numberSeed, windowSeed);
        bytes32 key = escrow.keyOf(a.repoId, a.kind, a.number);
        Config memory c = activeModel[a.repoId];
        address caller = _anyone(callerSeed);
        if (c.maintainer == address(0) || model[key].status == BonaFideEscrow.Status.Active) {
            vm.prank(caller);
            try escrow.depositWithAuthorization(
                a.repoId, a.kind, a.number, a.from, a.validAfter, a.validBefore, a.salt, a.signature
            ) {
                invalidDepositAccepted = true;
            } catch {}
            stats.rejectedDeposits++;
            return;
        }
        vm.prank(caller);
        escrow.depositWithAuthorization(
            a.repoId, a.kind, a.number, a.from, a.validAfter, a.validBefore, a.salt, a.signature
        );
        _modelDeposit(key, a.from, c);
        usedAuthorizations.push(a);
        stats.authorizedDeposits++;
    }

    function reuseAuthorization(
        uint256 authorizationSeed,
        uint256 repoSeed,
        uint256 kindSeed,
        uint256 numberSeed,
        uint256 callerSeed
    ) external {
        Authorization memory a;
        bool found;
        for (uint256 i; i < usedAuthorizations.length && !found; ++i) {
            a = usedAuthorizations[(authorizationSeed % usedAuthorizations.length + i) % usedAuthorizations.length];
            found = block.timestamp < a.validBefore;
        }
        if (!found) return;
        if (repoSeed % 2 == 0) {
            a.repoId = repoIds[repoSeed / 2 % repoIds.length];
            a.kind = BonaFideEscrow.Kind(kindSeed % 2);
            a.number = uint64(_bound(numberSeed, 1, 2));
        }
        vm.prank(_anyone(callerSeed));
        try escrow.depositWithAuthorization(
            a.repoId, a.kind, a.number, a.from, a.validAfter, a.validBefore, a.salt, a.signature
        ) {
            invalidDepositAccepted = true;
        } catch {}
        stats.authorizationReuseAttempts++;
    }

    function refundByKeeper(uint256 keySeed) external {
        if (keys.length == 0) return;
        bytes32 key = _pick(keySeed);
        Model storage m = model[key];
        if (m.status != BonaFideEscrow.Status.Active) {
            vm.prank(keeper);
            try escrow.refund(key) {
                resolvedTwice = true;
            } catch {}
            return;
        }
        uint256[] memory before = _balances();
        vm.prank(keeper);
        escrow.refund(key);
        _recordInflows(before);
        m.status = BonaFideEscrow.Status.Refunded;
        expectedInflow[m.depositor] += m.amount;
        stats.keeperRefunds++;
    }

    function refundByAnyone(uint256 keySeed, uint256 callerSeed) external {
        if (keys.length == 0) return;
        bytes32 key = _pick(keySeed);
        Model storage m = model[key];
        if (m.status == BonaFideEscrow.Status.Active && block.timestamp >= m.deadline) {
            _refundAfterDeadline(key, _anyone(callerSeed));
            return;
        }
        bool active = m.status == BonaFideEscrow.Status.Active;
        vm.prank(_anyone(callerSeed));
        try escrow.refund(key) {
            if (active) strangerRefundedEarly = true;
            else resolvedTwice = true;
        } catch {}
        stats.earlyRefundAttempts++;
    }

    function forfeit(uint256 keySeed, uint256 relayerSeed, uint256 sigWindow) external {
        if (keys.length == 0) return;
        bytes32 key = _pick(keySeed);
        Model storage m = model[key];
        if (m.status != BonaFideEscrow.Status.Active) return;
        uint256 sigDeadline = block.timestamp + _bound(sigWindow, 0, 400 days);
        bytes memory sig = _maintainerSignature(key, sigDeadline);
        address relayer = _relayerOrKeeper(relayerSeed);
        if (block.timestamp >= m.deadline) {
            vm.prank(relayer);
            try escrow.forfeit(key, sigDeadline, sig) {
                forfeitAfterDeadline = true;
            } catch {}
            stats.lateForfeitAttempts++;
            return;
        }
        uint256[] memory before = _balances();
        uint256 sinkBefore = usdc.balanceOf(FORFEIT_SINK);
        vm.prank(relayer);
        escrow.forfeit(key, sigDeadline, sig);
        _recordInflows(before);
        if ((usdc.balanceOf(FORFEIT_SINK) - sinkBefore) * 2 > m.amount) forfeitAboveHalf = true;
        uint256 expectedForfeit = m.amount * m.forfeitBps / 10_000;
        m.status = BonaFideEscrow.Status.Forfeited;
        expectedInflow[FORFEIT_SINK] += expectedForfeit;
        expectedInflow[m.depositor] += m.amount - expectedForfeit;
        stats.forfeits++;
    }

    function maintainerSignsWithoutSubmitting(uint256 keySeed, uint256 sigWindow) external {
        if (keys.length == 0) return;
        bytes32 key = _pick(keySeed);
        if (model[key].status != BonaFideEscrow.Status.Active) return;
        _maintainerSignature(key, block.timestamp + _bound(sigWindow, 0, 400 days));
    }

    function replayOldSignature(uint256 keySeed, uint256 relayerSeed) external {
        bytes32 key;
        bool found;
        for (uint256 i; i < keys.length && !found; ++i) {
            key = keys[(keySeed % keys.length + i) % keys.length];
            Model storage m = model[key];
            found = oldSig[key].length != 0 && oldSigSerial[key] != m.serial && m.status == BonaFideEscrow.Status.Active
                && block.timestamp < m.deadline && block.timestamp <= oldSigDeadline[key];
        }
        if (!found) return;
        bytes memory sig = oldSig[key];
        uint256 sigDeadline = oldSigDeadline[key];
        vm.prank(_relayerOrKeeper(relayerSeed));
        try escrow.forfeit(key, sigDeadline, sig) {
            replayAccepted = true;
        } catch {}
        stats.replayAttempts++;
    }

    function keeperForfeit(uint256 keySeed, uint256 mode) external {
        if (keys.length == 0) return;
        bytes32 key = keys[keySeed % keys.length];
        Model storage m = model[key];
        uint256 sigDeadline = block.timestamp + 1 days;
        bytes memory sig;
        mode = mode % 3;
        if (mode == 0) {
            sig = _sign(keeperPk, key, m.serial, sigDeadline);
        } else if (mode == 1) {
            sig = _sign(signingKey[_otherMaintainer(m.maintainer)], key, m.serial, sigDeadline);
        } else {
            sig = abi.encodePacked(keccak256(abi.encode(key)), keccak256(abi.encode(sigDeadline)), uint8(27));
        }
        vm.prank(keeper);
        try escrow.forfeit(key, sigDeadline, sig) {
            keeperForfeited = true;
        } catch {}
        stats.keeperForfeitAttempts++;
    }

    function afterDeadline(uint256 keySeed, uint256 extra, uint256 callerSeed) external {
        if (keys.length == 0) return;
        bytes32 key = _pick(keySeed);
        Model storage m = model[key];
        if (m.status != BonaFideEscrow.Status.Active || m.deadline > vm.getBlockTimestamp() + 3 days) return;
        uint256 target = uint256(m.deadline) + (extra % 3 == 0 ? 0 : _bound(extra, 1, 1 days));
        if (vm.getBlockTimestamp() < target) vm.warp(target);
        uint256 sigDeadline = block.timestamp + 1 days;
        bytes memory sig = _sign(signingKey[m.maintainer], key, m.serial, sigDeadline);
        vm.prank(_relayerOrKeeper(callerSeed));
        try escrow.forfeit(key, sigDeadline, sig) {
            forfeitAfterDeadline = true;
        } catch {}
        stats.lateForfeitAttempts++;
        _refundAfterDeadline(key, _anyone(callerSeed));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + _bound(secs, 0, 2 days));
        stats.warps++;
    }

    function statsSnapshot() external view returns (Stats memory) {
        return stats;
    }

    function allKeys() external view returns (bytes32[] memory) {
        return keys;
    }

    function allRepoIds() external view returns (bytes32[] memory) {
        return repoIds;
    }

    function trackedAddresses() external view returns (address[] memory) {
        return tracked;
    }

    function allMaintainers() external view returns (address[] memory) {
        return maintainers;
    }

    function allRelayers() external view returns (address[] memory) {
        return relayers;
    }

    function activeConfigModel(bytes32 repoId) external view returns (Config memory) {
        return activeModel[repoId];
    }

    function pendingConfigModel(bytes32 repoId) external view returns (Config memory, uint64) {
        return (pendingModel[repoId], effectiveAtModel[repoId]);
    }

    function _refundAfterDeadline(bytes32 key, address caller) internal {
        Model storage m = model[key];
        uint256[] memory before = _balances();
        vm.prank(caller);
        try escrow.refund(key) {
            _recordInflows(before);
            m.status = BonaFideEscrow.Status.Refunded;
            expectedInflow[m.depositor] += m.amount;
            stats.refundsAfterDeadline++;
        } catch {
            refundAfterDeadlineFailed = true;
        }
    }

    function _modelDeposit(bytes32 key, address depositor, Config memory c) internal {
        model[key] = Model(
            depositor,
            c.maintainer,
            c.forfeitBps,
            uint64(block.timestamp) + c.timeout,
            ++serialModel,
            c.amount,
            BonaFideEscrow.Status.Active
        );
        if (!seenKey[key]) {
            seenKey[key] = true;
            keys.push(key);
        }
    }

    function _authorize(
        uint256 depositorSeed,
        uint256 repoSeed,
        uint256 kindSeed,
        uint256 numberSeed,
        uint256 windowSeed
    ) internal returns (Authorization memory a) {
        a.repoId = repoIds[repoSeed % repoIds.length];
        a.kind = BonaFideEscrow.Kind(kindSeed % 2);
        a.number = uint64(_bound(numberSeed, 1, 2));
        a.from = depositors[depositorSeed % depositors.length];
        a.validAfter = block.timestamp - 1;
        a.validBefore = block.timestamp + _bound(windowSeed, 1, 400 days);
        a.salt = bytes32(++authorizationCount);
        a.signature = _signReceive(a, activeModel[a.repoId].amount);
    }

    function _signReceive(Authorization memory a, uint256 value) internal view returns (bytes memory) {
        bytes32 nonce = keccak256(abi.encode(escrow.keyOf(a.repoId, a.kind, a.number), a.salt));
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                a.from,
                address(escrow),
                value,
                a.validAfter,
                a.validBefore,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signingKey[a.from], keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _maintainerSignature(bytes32 key, uint256 sigDeadline) internal returns (bytes memory sig) {
        Model storage m = model[key];
        sig = _sign(signingKey[m.maintainer], key, m.serial, sigDeadline);
        oldSig[key] = sig;
        oldSigSerial[key] = m.serial;
        oldSigDeadline[key] = sigDeadline;
    }

    function _sign(uint256 pk, bytes32 key, uint64 serial, uint256 sigDeadline) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BonaFide"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)"), key, uint256(serial), sigDeadline
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

    function _pick(uint256 seed) internal view returns (bytes32) {
        uint256 start = seed % keys.length;
        if (seed % 4 == 0) return keys[start];
        for (uint256 i; i < keys.length; ++i) {
            bytes32 key = keys[(start + i) % keys.length];
            if (model[key].status == BonaFideEscrow.Status.Active) return key;
        }
        return keys[start];
    }

    function _anyone(uint256 seed) internal view returns (address) {
        uint256 i = seed % (relayers.length + depositors.length + 3);
        if (i < relayers.length) return relayers[i];
        i -= relayers.length;
        if (i < depositors.length) return depositors[i];
        return maintainers[i - depositors.length];
    }

    function _relayerOrKeeper(uint256 seed) internal view returns (address) {
        uint256 i = seed % (relayers.length + 1);
        return i == relayers.length ? keeper : relayers[i];
    }

    function _otherMaintainer(address current) internal view returns (address) {
        for (uint256 i; i < maintainers.length; ++i) {
            if (maintainers[i] != current) return maintainers[i];
        }
        revert("unreachable");
    }
}
