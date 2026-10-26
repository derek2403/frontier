// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// A gas and latency experiment, not production code.
//
// SolanaLightClient checks a BLS12-381 certificate in the shape Alpenglow
// uses (SIMD-0326): one aggregate signature from validators holding at least
// `thresholdPct` of stake. The validator set here is SIMULATED: keys we made.
// It also takes an `approvalsRoot`, a Merkle root of SODA approvals in the
// certified block. Real Solana blocks do not commit to such a root today;
// that link is the open problem this experiment does not solve.

library Bls {
    address constant G1MSM = address(0x0c);
    address constant G2ADD = address(0x0d);
    address constant PAIRING = address(0x0f);
    address constant MAP_FP2_TO_G2 = address(0x11);
    address constant MODEXP = address(0x05);

    bytes constant P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    function slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[start + i];
    }

    // RFC 9380 expand_message_xmd with SHA-256, 256 output bytes.
    function expand(bytes memory dst, bytes memory message) internal pure returns (bytes memory out) {
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));
        bytes32 b0 = sha256(abi.encodePacked(new bytes(64), message, uint16(256), uint8(0), dstPrime));
        out = new bytes(256);
        bytes32 bi = sha256(abi.encodePacked(b0, uint8(1), dstPrime));
        assembly { mstore(add(out, 32), bi) }
        for (uint256 i = 2; i <= 8; i++) {
            bi = sha256(abi.encodePacked(b0 ^ bi, uint8(i), dstPrime));
            assembly { mstore(add(out, mul(i, 32)), bi) }
        }
    }

    function modP(bytes memory b64) internal view returns (bytes memory) {
        (bool ok, bytes memory r) =
            MODEXP.staticcall(abi.encodePacked(uint256(64), uint256(1), uint256(48), b64, uint8(1), P));
        require(ok && r.length == 48, "modexp");
        return abi.encodePacked(bytes16(0), r);
    }

    function mapToG2(bytes memory c0, bytes memory c1) internal view returns (bytes memory) {
        (bool ok, bytes memory r) = MAP_FP2_TO_G2.staticcall(abi.encodePacked(modP(c0), modP(c1)));
        require(ok && r.length == 256, "map");
        return r;
    }

    // RFC 9380 hash_to_curve for G2 (BLS12381G2_XMD:SHA-256_SSWU_RO_).
    function hashToG2(bytes memory dst, bytes memory message) internal view returns (bytes memory) {
        bytes memory u = expand(dst, message);
        bytes memory q0 = mapToG2(slice(u, 0, 64), slice(u, 64, 64));
        bytes memory q1 = mapToG2(slice(u, 128, 64), slice(u, 192, 64));
        (bool ok, bytes memory r) = G2ADD.staticcall(abi.encodePacked(q0, q1));
        require(ok && r.length == 256, "g2add");
        return r;
    }

    function msm(bytes memory input) internal view returns (bytes memory) {
        (bool ok, bytes memory r) = G1MSM.staticcall(input);
        require(ok && r.length == 128, "msm");
        return r;
    }

    function pairingIsOne(bytes memory input) internal view returns (bool) {
        (bool ok, bytes memory r) = PAIRING.staticcall(input);
        require(ok && r.length == 32, "pairing");
        return uint256(bytes32(r)) == 1;
    }
}

library Merkle {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}

contract SolanaLightClient {
    // r - 1: multiplying a point by it negates the point.
    uint256 constant R_MINUS_1 = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000;

    struct NonSigner {
        bytes pk;
        uint64 stake;
        bytes32[] proof;
    }

    address public immutable admin;
    bytes public dst;
    bytes public negG1;
    bytes public aggPk;
    uint256 public totalStake;
    bytes32 public validatorRoot;
    uint256 public thresholdPct;
    mapping(bytes32 => bytes32) public finalized;

    event Finalized(bytes32 indexed blockId, bytes32 approvalsRoot, uint256 signedStake);

    constructor(bytes memory _dst, bytes memory _negG1, uint256 _thresholdPct) {
        admin = msg.sender;
        dst = _dst;
        negG1 = _negG1;
        thresholdPct = _thresholdPct;
    }

    // Simulation shortcut: a real light client accepts a new set only with a
    // certificate from the previous set.
    function setEpoch(bytes calldata _aggPk, uint256 _totalStake, bytes32 _root) external {
        require(msg.sender == admin, "admin");
        aggPk = _aggPk;
        totalStake = _totalStake;
        validatorRoot = _root;
    }

    function submitCertificate(
        bytes32 blockId,
        bytes32 approvalsRoot,
        bytes calldata sig,
        NonSigner[] calldata nonSigners
    ) external {
        uint256 n = nonSigners.length;
        bytes memory msmIn = new bytes((n + 1) * 160);
        bytes memory apkAll = aggPk;
        assembly {
            mcopy(add(msmIn, 32), add(apkAll, 32), 128)
            mstore(add(msmIn, 160), 1)
        }
        uint256 missing;
        bytes32 prev;
        for (uint256 i = 0; i < n; i++) {
            NonSigner calldata ns = nonSigners[i];
            bytes32 leaf = keccak256(abi.encodePacked(ns.pk, ns.stake));
            require(leaf > prev, "order");
            prev = leaf;
            require(Merkle.verify(ns.proof, validatorRoot, leaf), "not a validator");
            missing += ns.stake;
            bytes calldata pk = ns.pk;
            uint256 off = (i + 1) * 160;
            assembly {
                calldatacopy(add(add(msmIn, 32), off), pk.offset, 128)
                mstore(add(add(msmIn, 160), off), R_MINUS_1)
            }
        }
        uint256 signed = totalStake - missing;
        require(signed * 100 >= totalStake * thresholdPct, "stake");

        bytes memory apk = Bls.msm(msmIn);
        bytes memory h = Bls.hashToG2(dst, abi.encodePacked("SODA-alpenglow-sim", blockId, approvalsRoot));
        require(Bls.pairingIsOne(abi.encodePacked(apk, h, negG1, sig)), "bad signature");

        finalized[blockId] = approvalsRoot;
        emit Finalized(blockId, approvalsRoot, signed);
    }
}

contract SodaAccount {
    bytes32 public immutable owner;
    SolanaLightClient public immutable lc;
    uint64 public nonce;

    constructor(bytes32 _owner, address _lc) {
        owner = _owner;
        lc = SolanaLightClient(_lc);
    }

    receive() external payable {}

    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        uint64 _nonce,
        uint64 deadline,
        bytes32 blockId,
        bytes32[] calldata proof
    ) external returns (bytes memory) {
        require(_nonce == nonce, "nonce");
        require(block.timestamp <= deadline, "deadline");
        bytes32 root = lc.finalized(blockId);
        require(root != bytes32(0), "block not final");
        bytes32 leaf = keccak256(
            abi.encodePacked(block.chainid, address(this), owner, target, value, keccak256(data), _nonce, deadline)
        );
        require(Merkle.verify(proof, root, leaf), "approval not in block");
        nonce = _nonce + 1;
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        require(ok, "call failed");
        return ret;
    }
}

contract SodaAccountFactory {
    address public immutable lc;

    constructor(address _lc) {
        lc = _lc;
    }

    function accountAddress(bytes32 owner, bytes32 path) public view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(owner, path));
        bytes32 codeHash = keccak256(abi.encodePacked(type(SodaAccount).creationCode, abi.encode(owner, lc)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }

    function deployAndExecute(
        bytes32 owner,
        bytes32 path,
        address target,
        uint256 value,
        bytes calldata data,
        uint64 _nonce,
        uint64 deadline,
        bytes32 blockId,
        bytes32[] calldata proof
    ) external returns (address acct) {
        acct = accountAddress(owner, path);
        if (acct.code.length == 0) {
            new SodaAccount{salt: keccak256(abi.encodePacked(owner, path))}(owner, lc);
        }
        SodaAccount(payable(acct)).execute(target, value, data, _nonce, deadline, blockId, proof);
    }
}

// Checks a REAL Alpenglow certificate: the payload is the wincode
// VotePayloadToSign from Agave (tag | slot LE | block_id | shred_version LE),
// the signature is the aggregate BLS signature, and the keys are the real
// validators' BLS keys read from their vote accounts. No validator set or
// stake rule is stored here: this only proves the cryptography matches.
contract AlpenglowCertCheck {
    bytes public constant DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
    bytes public negG1;

    event Verified(uint64 slot, bytes32 blockId, uint256 signers);

    constructor(bytes memory _negG1) {
        negG1 = _negG1;
    }

    function le64(uint64 v) internal pure returns (bytes8 r) {
        for (uint256 i = 0; i < 8; i++) r |= bytes8(bytes1(uint8(v >> (8 * i)))) >> (8 * i);
    }

    function payload(uint8 tag, uint64 slot, bytes32 blockId, uint16 shredVersion) public pure returns (bytes memory) {
        return abi.encodePacked(tag, le64(slot), blockId, uint8(shredVersion), uint8(shredVersion >> 8));
    }

    function verify(uint8 tag, uint64 slot, bytes32 blockId, uint16 shredVersion, bytes[] calldata pks, bytes calldata sig)
        public
        view
        returns (bool)
    {
        bytes memory msmIn = new bytes(pks.length * 160);
        for (uint256 i = 0; i < pks.length; i++) {
            bytes calldata pk = pks[i];
            require(pk.length == 128, "pk");
            uint256 off = i * 160;
            assembly {
                calldatacopy(add(add(msmIn, 32), off), pk.offset, 128)
                mstore(add(add(msmIn, 160), off), 1)
            }
        }
        bytes memory apk = Bls.msm(msmIn);
        bytes memory h = Bls.hashToG2(DST, payload(tag, slot, blockId, shredVersion));
        return Bls.pairingIsOne(abi.encodePacked(apk, h, negG1, sig));
    }

    function record(uint8 tag, uint64 slot, bytes32 blockId, uint16 shredVersion, bytes[] calldata pks, bytes calldata sig) external {
        require(verify(tag, slot, blockId, shredVersion, pks, sig), "bad certificate");
        emit Verified(slot, blockId, pks.length);
    }
}

// A light client for REAL Alpenglow finality certificates (Agave 4.3/4.4).
//
// Checked here, with the real formats:
//   - signed bytes: tag | slot u64 LE | block_id (notarize only) | shred_version u16 LE
//   - signer bitmap: solana-signer-store base2 (version 0 | bit count u16 LE | bits, Lsb0),
//     bit i = validator at rank i (stake descending, then BLS key ascending)
//   - fast finality: one notarize aggregate on (slot, block_id), at least 80% of stake
//   - slow finality: a finalize aggregate on slot AND a notarize aggregate on the block, 60% each
//
// NOT proved here, and set by named roles instead:
//   - admin loads the validator set (no epoch handover proof exists yet)
//   - attester posts the SODA approvals root for a finalized block (no inclusion proof yet)
contract AlpenglowLightClient {
    bytes public constant DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
    address public immutable admin;
    address public immutable attester;
    bytes public negG1;
    uint16 public shredVersion;
    bytes[] public pks; // EIP-2537 G1, 128 bytes each, in rank order
    uint64[] public stakes;
    uint256 public totalStake;

    mapping(bytes32 => uint64) public finalizedSlot; // block_id -> slot (0 = not finalized)
    mapping(bytes32 => bytes32) public attestedRoot; // block_id -> approvals root

    event ValidatorSet(uint256 count, uint256 totalStake, uint16 shredVersion);
    event BlockFinalized(uint64 slot, bytes32 blockId, bool fast, uint256 signedStake);
    event ApprovalsAttested(bytes32 blockId, bytes32 root);

    constructor(bytes memory _negG1, address _attester) {
        admin = msg.sender;
        attester = _attester;
        negG1 = _negG1;
    }

    function setValidators(bytes[] calldata _pks, uint64[] calldata _stakes, uint16 _shredVersion) external {
        require(msg.sender == admin, "admin");
        require(_pks.length == _stakes.length && _pks.length > 0, "len");
        delete pks;
        delete stakes;
        uint256 t;
        for (uint256 i = 0; i < _pks.length; i++) {
            require(_pks[i].length == 128, "pk");
            pks.push(_pks[i]);
            stakes.push(_stakes[i]);
            t += _stakes[i];
        }
        totalStake = t;
        shredVersion = _shredVersion;
        emit ValidatorSet(_pks.length, t, _shredVersion);
    }

    function validatorCount() external view returns (uint256) {
        return pks.length;
    }

    function le64(uint64 v) internal pure returns (bytes8 r) {
        for (uint256 i = 0; i < 8; i++) r |= bytes8(bytes1(uint8(v >> (8 * i)))) >> (8 * i);
    }

    function notarPayload(uint64 slot, bytes32 blockId) public view returns (bytes memory) {
        return abi.encodePacked(uint8(1), le64(slot), blockId, uint8(shredVersion), uint8(shredVersion >> 8));
    }

    function finalizePayload(uint64 slot) public view returns (bytes memory) {
        return abi.encodePacked(uint8(2), le64(slot), uint8(shredVersion), uint8(shredVersion >> 8));
    }

    // Aggregates the keys of the validators whose bit is set, and their stake.
    function signers(bytes calldata bitmap) internal view returns (bytes memory apk, uint256 stake) {
        require(bitmap.length >= 3 && uint8(bitmap[0]) == 0, "bitmap version");
        uint256 nBits = uint256(uint8(bitmap[1])) | (uint256(uint8(bitmap[2])) << 8);
        require(nBits == pks.length, "bitmap size");
        require(bitmap.length == 3 + (nBits + 7) / 8, "bitmap length");
        uint256 count;
        for (uint256 i = 0; i < nBits; i++) if (uint8(bitmap[3 + i / 8]) & (1 << (i % 8)) != 0) count++;
        require(count > 0, "no signers");
        bytes memory msmIn = new bytes(count * 160);
        uint256 k;
        for (uint256 i = 0; i < nBits; i++) {
            if (uint8(bitmap[3 + i / 8]) & (1 << (i % 8)) == 0) continue;
            bytes memory pk = pks[i];
            uint256 off = k * 160;
            assembly {
                mcopy(add(add(msmIn, 32), off), add(pk, 32), 128)
                mstore(add(add(msmIn, 160), off), 1)
            }
            stake += stakes[i];
            k++;
        }
        apk = Bls.msm(msmIn);
    }

    function checkAggregate(bytes memory payload, bytes calldata sig, bytes calldata bitmap, uint256 pct)
        internal
        view
        returns (uint256 stake)
    {
        bytes memory apk;
        (apk, stake) = signers(bitmap);
        require(stake * 100 >= totalStake * pct, "stake");
        bytes memory h = Bls.hashToG2(DST, payload);
        require(Bls.pairingIsOne(abi.encodePacked(apk, h, negG1, sig)), "bad signature");
    }

    // notarSig empty = fast finality (finalSig is the notarize aggregate at 80%).
    function submitFinalCert(
        uint64 slot,
        bytes32 blockId,
        bytes calldata finalSig,
        bytes calldata finalBitmap,
        bytes calldata notarSig,
        bytes calldata notarBitmap
    ) external {
        uint256 signed;
        bool fast = notarSig.length == 0;
        if (fast) {
            signed = checkAggregate(notarPayload(slot, blockId), finalSig, finalBitmap, 80);
        } else {
            signed = checkAggregate(finalizePayload(slot), finalSig, finalBitmap, 60);
            checkAggregate(notarPayload(slot, blockId), notarSig, notarBitmap, 60);
        }
        finalizedSlot[blockId] = slot;
        emit BlockFinalized(slot, blockId, fast, signed);
    }

    function attestApprovals(bytes32 blockId, bytes32 root) external {
        require(msg.sender == attester, "attester");
        require(finalizedSlot[blockId] != 0, "block not finalized");
        attestedRoot[blockId] = root;
        emit ApprovalsAttested(blockId, root);
    }

    // Same interface the SodaAccount already reads: the approvals root of a
    // finalized block, or zero.
    function finalized(bytes32 blockId) external view returns (bytes32) {
        return finalizedSlot[blockId] == 0 ? bytes32(0) : attestedRoot[blockId];
    }
}

// Need 2, measured: recomputes an Alpenglow block_id from one data shred, the
// shred's own Merkle proof and the double Merkle proof (Agave 4.3.2 rules):
//   leaf = sha256(0x00 "SOLANA_MERKLE_SHREDS_LEAF" || shred[64..proof_offset])
//   node = sha256(0x01 "SOLANA_MERKLE_SHREDS_NODE" || left[0..20] || right[0..20])
// and checks that the transaction bytes sit in the shred's data at `txOffset`.
// Parsing the action out of the transaction is not included yet.
contract ShredInclusion {
    bytes constant LEAF = "\x00SOLANA_MERKLE_SHREDS_LEAF";
    bytes constant NODE = "\x01SOLANA_MERKLE_SHREDS_NODE";
    uint256 constant DATA_START = 88 - 64; // data header ends at 88; leafBytes starts at 64

    function join(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(NODE, bytes20(a), bytes20(b)));
    }

    function fold(bytes32 node, uint256 index, bytes20[] calldata proof) internal pure returns (bytes32) {
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = bytes32(proof[i]);
            node = index % 2 == 0 ? join(node, p) : join(p, node);
            index >>= 1;
        }
        return node;
    }

    function blockId(
        bytes calldata leafBytes,
        uint256 shredIndexInFec,
        bytes20[] calldata shredProof,
        uint256 fecSetNumber,
        bytes20[] calldata doubleProof,
        bytes calldata txBytes,
        uint256 txOffset
    ) public pure returns (bytes32) {
        // The transaction must lie inside this shred's data region.
        require(txOffset + txBytes.length <= leafBytes.length - DATA_START, "range");
        require(keccak256(leafBytes[DATA_START + txOffset:DATA_START + txOffset + txBytes.length]) == keccak256(txBytes), "tx not in shred");
        bytes32 leaf = sha256(abi.encodePacked(LEAF, leafBytes));
        return fold(fold(leaf, shredIndexInFec, shredProof), fecSetNumber, doubleProof);
    }
}
