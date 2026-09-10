//! Minimal BCS encoder for a Sui `TransactionData`, plus Sui's address and
//! hashing rules. Pure functions; must match `packages/soda-sdk/src/sui.ts`
//! byte-for-byte, and both are checked against the official `@mysten/sui`
//! SDK (vectors below were produced by it).
//!
//! Layout, from sui-types:
//!
//!   TransactionData::V1 {                   // enum tag 0
//!     kind:       TransactionKind,          // ProgrammableTransaction = tag 0
//!     sender:     SuiAddress,               // [u8; 32]
//!     gas_data: { payment: Vec<ObjectRef>,  // uleb len, then (id[32], u64 LE, uleb 32 + digest[32])
//!                 owner: SuiAddress,
//!                 price: u64, budget: u64 },
//!     expiration: TransactionExpiration,    // None = tag 0
//!   }
//!
//! The digest an explorer shows is blake2b256("TransactionData::" || bytes);
//! what gets signed is blake2b256(intent || bytes), and for secp256k1 Sui
//! hashes that once more with sha256 before the ECDSA check. That sha256
//! output is the 32-byte payload SODA commits to and recovers against.

use anchor_lang::prelude::*;
use solana_program::hash;

use crate::blake2b::blake2b_256;

pub const KIND_PROGRAMMABLE: u8 = 0x00;
pub const SUI_SECP256K1_FLAG: u8 = 0x01;
/// Intent { scope: TransactionData, version: V0, app_id: Sui }.
pub const INTENT_TRANSACTION_DATA: [u8; 3] = [0, 0, 0];
pub const TX_DIGEST_PREFIX: &[u8] = b"TransactionData::";

/// An owned object the transaction pays gas with. `digest` is the 32 bytes
/// behind the base58 string a Sui node prints.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SuiObjectRef {
    pub object_id: [u8; 32],
    pub version: u64,
    pub digest: [u8; 32],
}

fn uleb128(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// `TransactionKind::ProgrammableTransaction` that splits `amount_mist` off
/// the gas coin and transfers it:
///
///   inputs:   [Pure(u64 amount), Pure(address recipient)]
///   commands: [SplitCoins(GasCoin, [Input(0)]),
///              TransferObjects([NestedResult(0, 0)], Input(1))]
pub fn encode_transfer_kind(recipient: &[u8; 32], amount_mist: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.push(KIND_PROGRAMMABLE);
    out.push(2); // inputs
    out.push(0); // CallArg::Pure
    out.push(8);
    out.extend_from_slice(&amount_mist.to_le_bytes());
    out.push(0); // CallArg::Pure
    out.push(32);
    out.extend_from_slice(recipient);
    out.push(2); // commands
    out.extend_from_slice(&[2, 0, 1, 1, 0, 0]); // SplitCoins(GasCoin, [Input(0)])
    out.extend_from_slice(&[1, 1, 3, 0, 0, 0, 0, 1, 1, 0]); // TransferObjects([NestedResult(0,0)], Input(1))
    out
}

/// BCS `TransactionData::V1` around a caller-supplied `TransactionKind`.
pub fn encode_transaction_data(
    kind: &[u8],
    sender: &[u8; 32],
    gas_payment: &[SuiObjectRef],
    gas_owner: &[u8; 32],
    gas_price: u64,
    gas_budget: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + kind.len() + 32 + 1 + gas_payment.len() * 73 + 32 + 16 + 1);
    out.push(0); // TransactionData::V1
    out.extend_from_slice(kind);
    out.extend_from_slice(sender);
    uleb128(gas_payment.len() as u64, &mut out);
    for r in gas_payment {
        out.extend_from_slice(&r.object_id);
        out.extend_from_slice(&r.version.to_le_bytes());
        out.push(32); // ObjectDigest serialises as a byte vector
        out.extend_from_slice(&r.digest);
    }
    out.extend_from_slice(gas_owner);
    out.extend_from_slice(&gas_price.to_le_bytes());
    out.extend_from_slice(&gas_budget.to_le_bytes());
    out.push(0); // TransactionExpiration::None
    out
}

/// SEC1 compressed form of the 64-byte `X || Y` that `secp256k1_recover`
/// returns and `SigRequest.foreign_pk_xy` stores.
pub fn compress_pk_xy(xy: &[u8; 64]) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = if xy[63] & 1 == 1 { 0x03 } else { 0x02 };
    out[1..].copy_from_slice(&xy[..32]);
    out
}

/// `blake2b256(0x01 || compressed_pk)`.
pub fn sui_address_from_compressed_pk(pk: &[u8; 33]) -> [u8; 32] {
    let mut buf = [0u8; 34];
    buf[0] = SUI_SECP256K1_FLAG;
    buf[1..].copy_from_slice(pk);
    blake2b_256(&buf)
}

pub fn sui_address_from_pk_xy(xy: &[u8; 64]) -> [u8; 32] {
    sui_address_from_compressed_pk(&compress_pk_xy(xy))
}

/// `blake2b256(intent || tx_bytes)`.
pub fn intent_digest(tx_bytes: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(3 + tx_bytes.len());
    msg.extend_from_slice(&INTENT_TRANSACTION_DATA);
    msg.extend_from_slice(tx_bytes);
    blake2b_256(&msg)
}

/// `sha256(blake2b256(intent || tx_bytes))` — the 32 bytes soda stores and
/// `finalize_signature` recovers against. sha256 is a syscall on-chain.
pub fn signing_payload(tx_bytes: &[u8]) -> [u8; 32] {
    hash::hashv(&[&intent_digest(tx_bytes)]).to_bytes()
}

/// The digest explorers show, before base58.
pub fn transaction_digest(tx_bytes: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(TX_DIGEST_PREFIX.len() + tx_bytes.len());
    msg.extend_from_slice(TX_DIGEST_PREFIX);
    msg.extend_from_slice(tx_bytes);
    blake2b_256(&msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let s = s.trim_start_matches("0x");
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn arr<const N: usize>(v: &[u8]) -> [u8; N] {
        let mut out = [0u8; N];
        out.copy_from_slice(v);
        out
    }

    // Vectors from @mysten/sui 2.30.0: Secp256k1Keypair.fromSecretKey([7;32]),
    // Transaction { splitCoins(gas, [1_000_000]) → transferObjects(0x33…33) },
    // gas = { 0x11…11, v5, digest 0x22…22 }, price 1000, budget 5_000_000.
    const PK: &str = "02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f";
    const ADDR: &str = "3334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6";
    const KIND: &str = "0002000840420f0000000000002033333333333333333333333333333333333333333333333333333333333333330202000101000001010300000000010100";
    const FULL: &str = "000002000840420f00000000000020333333333333333333333333333333333333333333333333333333333333333302020001010000010103000000000101003334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a601111111111111111111111111111111111111111111111111111111111111111105000000000000002022222222222222222222222222222222222222222222222222222222222222223334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6e803000000000000404b4c000000000000";
    const FULL_TWO_GAS: &str = "000002000840420f00000000000020333333333333333333333333333333333333333333333333333333333333333302020001010000010103000000000101003334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6021111111111111111111111111111111111111111111111111111111111111111050000000000000020222222222222222222222222222222222222222222222222222222222222222244444444444444444444444444444444444444444444444444444444444444444d000000000000002055555555555555555555555555555555555555555555555555555555555555553334442090548419b94695cbb1838652bb0494b54ff855494dd83491a3cfb6a6e803000000000000404b4c000000000000";
    const INTENT_DIGEST: &str = "72ffe4a0f6d4258326f48bfeef7e0e58dddaa1b21d8319c16474cc252b1faaec";
    const PAYLOAD: &str = "e9fb38bd6193c0a9b9d3bb800364c5ece94f42823238f1899ef0aed2b17de667";
    const TX_DIGEST: &str = "bc6d19b19c6b31e6e8bbbd82724a89960c49946e4f998d1ea792610310a86737";

    fn gas_ref() -> SuiObjectRef {
        SuiObjectRef { object_id: [0x11; 32], version: 5, digest: [0x22; 32] }
    }

    #[test]
    fn uleb128_single_and_multi_byte() {
        let mut out = Vec::new();
        uleb128(0, &mut out);
        uleb128(127, &mut out);
        uleb128(128, &mut out);
        uleb128(300, &mut out);
        assert_eq!(out, vec![0x00, 0x7f, 0x80, 0x01, 0xac, 0x02]);
    }

    #[test]
    fn transfer_kind_matches_mysten_sdk() {
        assert_eq!(encode_transfer_kind(&[0x33; 32], 1_000_000), unhex(KIND));
    }

    #[test]
    fn transaction_data_matches_mysten_sdk() {
        let sender = arr::<32>(&unhex(ADDR));
        let kind = encode_transfer_kind(&[0x33; 32], 1_000_000);
        let bytes = encode_transaction_data(&kind, &sender, &[gas_ref()], &sender, 1000, 5_000_000);
        assert_eq!(bytes, unhex(FULL));
    }

    #[test]
    fn two_gas_coins_match_mysten_sdk() {
        let sender = arr::<32>(&unhex(ADDR));
        let kind = encode_transfer_kind(&[0x33; 32], 1_000_000);
        let second = SuiObjectRef { object_id: [0x44; 32], version: 77, digest: [0x55; 32] };
        let bytes = encode_transaction_data(&kind, &sender, &[gas_ref(), second], &sender, 1000, 5_000_000);
        assert_eq!(bytes, unhex(FULL_TWO_GAS));
    }

    #[test]
    fn address_from_compressed_pk() {
        let pk = arr::<33>(&unhex(PK));
        assert_eq!(sui_address_from_compressed_pk(&pk), arr::<32>(&unhex(ADDR)));
    }

    #[test]
    fn compress_keeps_x_and_encodes_parity() {
        let mut xy = [0u8; 64];
        xy[..32].copy_from_slice(&[0xab; 32]);
        xy[63] = 0x02; // even y
        assert_eq!(compress_pk_xy(&xy)[0], 0x02);
        assert_eq!(&compress_pk_xy(&xy)[1..], &[0xab; 32]);
        xy[63] = 0x03; // odd y
        assert_eq!(compress_pk_xy(&xy)[0], 0x03);
    }

    #[test]
    fn hashes_match_mysten_sdk() {
        let bytes = unhex(FULL);
        assert_eq!(intent_digest(&bytes), arr::<32>(&unhex(INTENT_DIGEST)));
        assert_eq!(signing_payload(&bytes), arr::<32>(&unhex(PAYLOAD)));
        assert_eq!(transaction_digest(&bytes), arr::<32>(&unhex(TX_DIGEST)));
    }
}
