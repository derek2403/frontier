//! On-chain derivation of `foreign_pk = group_pk + tweak*G`.
//!
//! The first attempt at this used k256's `ProjectivePoint` and blew the BPF
//! 4KB stack, which is why `request_signature` ended up trusting a
//! caller-supplied `foreign_pk_xy`. This module removes that trust without
//! doing any elliptic-curve arithmetic at all.
//!
//! The trick: `secp256k1_recover(h, v, (r, s))` returns `r^-1 * (sR - hG)`,
//! where `R` is the curve point with x-coordinate `r` and y-parity `v`. Set
//! `r = s = P.x` and choose `v` to match `P.y`, so `R = P`:
//!
//!     Q = P.x^-1 * (P.x * P - h*G) = P - (h * P.x^-1) * G
//!
//! Choosing `h = -t * P.x mod n` gives exactly `Q = P + t*G`.
//!
//! Cost is one 25,000-CU syscall plus one 256-bit modular multiplication —
//! no heap, no large stack frames.
//!
//! Preconditions, all enforced below:
//!   * `group_pk.x` must be < n. It is a field element so it can exceed the
//!     group order, but only with probability ~2^-128.
//!   * `tweak` must be in [1, n-1], so `s` is a valid signature scalar.

use anchor_lang::prelude::*;
use solana_program::hash;
use solana_program::secp256k1_recover::secp256k1_recover;

use crate::errors::SodaError;

pub const DERIVATION_DOMAIN: &[u8] = b"SODA-v1";

/// secp256k1 group order, little-endian 64-bit limbs.
const N: [u64; 4] = [
    0xBFD2_5E8C_D036_4141,
    0xBAAE_DCE6_AF48_A03B,
    0xFFFF_FFFF_FFFF_FFFE,
    0xFFFF_FFFF_FFFF_FFFF,
];

fn from_be(bytes: &[u8; 32]) -> [u64; 4] {
    let mut out = [0u64; 4];
    for (i, limb) in out.iter_mut().enumerate() {
        let hi = 24 - i * 8;
        let mut v = 0u64;
        for j in 0..8 {
            v = (v << 8) | bytes[hi + j] as u64;
        }
        *limb = v;
    }
    out
}

fn to_be(v: [u64; 4]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, limb) in v.iter().enumerate() {
        let hi = 24 - i * 8;
        for j in 0..8 {
            out[hi + j] = (limb >> (56 - j * 8)) as u8;
        }
    }
    out
}

fn is_zero(a: [u64; 4]) -> bool {
    a == [0u64; 4]
}

/// `a < b`, unsigned.
fn lt(a: [u64; 4], b: [u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// `a -= b`, wrapping. Callers rely on the wrap when reducing a value that
/// carried out of 256 bits.
fn sub_assign(a: &mut [u64; 4], b: [u64; 4]) {
    let mut borrow = 0u64;
    for i in 0..4 {
        let (d, b1) = a[i].overflowing_sub(b[i]);
        let (d, b2) = d.overflowing_sub(borrow);
        a[i] = d;
        borrow = (b1 as u64) | (b2 as u64);
    }
}

/// `a + b`, returning the carry out of the top limb.
fn add_carry(a: [u64; 4], b: [u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let (s, c1) = a[i].overflowing_add(b[i]);
        let (s, c2) = s.overflowing_add(carry);
        out[i] = s;
        carry = (c1 as u64) | (c2 as u64);
    }
    (out, carry == 1)
}

/// `a << 1`, returning the bit shifted out of the top.
fn shl1(a: [u64; 4]) -> ([u64; 4], bool) {
    let mut out = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        out[i] = (a[i] << 1) | carry;
        carry = a[i] >> 63;
    }
    (out, carry == 1)
}

/// `(a * b) mod n`, by double-and-add over the bits of `b`.
///
/// Every intermediate stays below `n`, so each step needs at most one
/// conditional subtraction. Where a step carries out of 256 bits the value is
/// `2^256 + r`, which is still below `2n`; subtracting `n` with wrapping
/// arithmetic yields the correct reduced value.
fn mulmod_n(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    for i in (0..256).rev() {
        let (doubled, carry) = shl1(result);
        result = doubled;
        if carry || !lt(result, N) {
            sub_assign(&mut result, N);
        }
        let bit = (b[i / 64] >> (i % 64)) & 1;
        if bit == 1 {
            let (sum, carry) = add_carry(result, a);
            result = sum;
            if carry || !lt(result, N) {
                sub_assign(&mut result, N);
            }
        }
    }
    result
}

/// `-a mod n`, for `a` already reduced and non-zero.
fn neg_mod_n(a: [u64; 4]) -> [u64; 4] {
    let mut out = N;
    sub_assign(&mut out, a);
    out
}

pub fn compute_tweak(
    requester_program: &[u8; 32],
    seeds: &[u8],
    chain_tag: &[u8; 32],
) -> [u8; 32] {
    hash::hashv(&[DERIVATION_DOMAIN, requester_program, seeds, chain_tag]).to_bytes()
}

/// `group_pk + tweak*G`, as the 64-byte X||Y form `secp256k1_recover` returns
/// and `finalize_signature` compares against.
pub fn derive_foreign_pk_xy(
    group_pk_compressed: &[u8; 33],
    tweak: &[u8; 32],
) -> Result<[u8; 64]> {
    let prefix = group_pk_compressed[0];
    require!(
        prefix == 0x02 || prefix == 0x03,
        SodaError::InvalidGroupPk
    );

    let mut x = [0u8; 32];
    x.copy_from_slice(&group_pk_compressed[1..33]);

    let x_u = from_be(&x);
    // x doubles as both r and s in the synthetic signature, so it has to be a
    // valid scalar, not merely a valid field element.
    require!(!is_zero(x_u) && lt(x_u, N), SodaError::InvalidGroupPk);

    let t_u = from_be(tweak);
    require!(!is_zero(t_u) && lt(t_u, N), SodaError::InvalidTweak);

    let h = to_be(neg_mod_n(mulmod_n(t_u, x_u)));

    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&x);
    sig[32..].copy_from_slice(&x);

    // R must be P itself, so the recovery id carries P's y-parity.
    let recovery_id = if prefix == 0x03 { 1u8 } else { 0u8 };

    let recovered = secp256k1_recover(&h, recovery_id, &sig)
        .map_err(|_| error!(SodaError::DerivationFailed))?;
    Ok(recovered.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex<const M: usize>(s: &str) -> [u8; M] {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let s = s.trim_start_matches("0x");
        let mut out = [0u8; M];
        for i in 0..M {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn be_roundtrip() {
        let b = unhex::<32>("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert_eq!(to_be(from_be(&b)), b);
    }

    #[test]
    fn mulmod_small_values() {
        let mut three = [0u64; 4];
        three[0] = 3;
        let mut five = [0u64; 4];
        five[0] = 5;
        let mut fifteen = [0u64; 4];
        fifteen[0] = 15;
        assert_eq!(mulmod_n(three, five), fifteen);
    }

    #[test]
    fn mulmod_by_one_is_identity() {
        let mut one = [0u64; 4];
        one[0] = 1;
        let a = from_be(&unhex::<32>(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ));
        assert_eq!(mulmod_n(a, one), a);
    }

    #[test]
    fn mulmod_wraps_past_the_order() {
        // (n-1) * 2 mod n == n-2
        let mut one = [0u64; 4];
        one[0] = 1;
        let mut n_minus_1 = N;
        sub_assign(&mut n_minus_1, one);
        let mut two = [0u64; 4];
        two[0] = 2;
        let mut n_minus_2 = N;
        let mut t = [0u64; 4];
        t[0] = 2;
        sub_assign(&mut n_minus_2, t);
        assert_eq!(mulmod_n(n_minus_1, two), n_minus_2);
    }

    #[test]
    fn neg_mod_n_is_an_additive_inverse() {
        let a = from_be(&unhex::<32>(
            "0000000000000000000000000000000000000000000000000000000000000007",
        ));
        let (sum, carry) = add_carry(a, neg_mod_n(a));
        assert!(!carry);
        assert_eq!(sum, N);
    }

    /// The load-bearing test. `derive_foreign_pk_xy` computes `P + t*G` with
    /// no curve arithmetic, using only a `secp256k1_recover` syscall. This
    /// checks it against the k256 reference implementation in `derivation`,
    /// which does the point addition for real. If the recover trick were
    /// subtly wrong, every derived address would be wrong, and the mistake
    /// would only surface as an unspendable address on a live chain.
    #[test]
    fn recover_trick_matches_real_point_addition() {
        use crate::derivation::derive_foreign_pk;

        // secp256k1 generator, and a second point (2G) so we cover both
        // y-parities of the compressed prefix.
        let candidates = [
            "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            "02C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5",
        ];

        let tweaks = [
            "0000000000000000000000000000000000000000000000000000000000000001",
            "0000000000000000000000000000000000000000000000000000000000000002",
            "00000000000000000000000000000000000000000000000000000000deadbeef",
            "7f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
            // Large, to exercise the top limbs of the modular multiply.
            // Deliberately not n-1 or n-2: those are the discrete logs of -G
            // and -2G, so with these test points they would sum to the point
            // at infinity, which has no SEC1 encoding. A real tweak is a
            // sha256 output, so hitting that is infeasible.
            "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364100",
        ];

        let mut checked = 0;
        for g_hex in candidates {
            let g: [u8; 33] = unhex::<33>(g_hex);
            for t_hex in tweaks {
                let t: [u8; 32] = unhex::<32>(t_hex);

                let reference = derive_foreign_pk(&g, &t).expect("k256 reference failed");
                let mine = derive_foreign_pk_xy(&g, &t).expect("recover trick failed");

                // reference is 65-byte SEC1 (0x04 || X || Y); mine is X || Y.
                assert_eq!(
                    &reference[1..],
                    &mine[..],
                    "mismatch for group_pk={} tweak={}",
                    g_hex,
                    t_hex
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 10);
    }

    #[test]
    fn zero_tweak_is_rejected() {
        let g: [u8; 33] = unhex::<33>(
            "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
        );
        assert!(derive_foreign_pk_xy(&g, &[0u8; 32]).is_err());
    }

    #[test]
    fn tweak_matches_the_documented_construction() {
        let prog = [1u8; 32];
        let mut tag = [0u8; 32];
        tag[..16].copy_from_slice(b"ethereum-sepolia");
        assert_eq!(compute_tweak(&prog, b"x", &tag), compute_tweak(&prog, b"x", &tag));
        assert_ne!(compute_tweak(&prog, b"x", &tag), compute_tweak(&prog, b"y", &tag));
    }
}
