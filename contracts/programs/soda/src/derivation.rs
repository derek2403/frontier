// Derivation contract — must match TS SDK byte-for-byte.
//
//   tweak       = sha256(DERIVATION_DOMAIN || requester_program || seeds || chain_tag)
//   foreign_pk  = group_pk + tweak * G                 (secp256k1 point add)
//   eth_address = keccak256(uncompressed_pk[1..])[12..]
//
// foreign_pk is encoded as 65-byte SEC1 uncompressed (0x04 || X || Y).

use anchor_lang::prelude::*;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar};
use solana_program::{hash, keccak};

use crate::errors::SodaError;

pub const DERIVATION_DOMAIN: &[u8] = b"SODA-v1";

pub fn compute_tweak(
    requester_program: &[u8; 32],
    seeds: &[u8],
    chain_tag: &[u8; 32],
) -> [u8; 32] {
    hash::hashv(&[DERIVATION_DOMAIN, requester_program, seeds, chain_tag]).to_bytes()
}

pub fn derive_foreign_pk(
    group_pk_compressed: &[u8; 33],
    tweak_bytes: &[u8; 32],
) -> Result<[u8; 65]> {
    let ep = EncodedPoint::from_bytes(group_pk_compressed)
        .map_err(|_| error!(SodaError::InvalidGroupPk))?;
    let group_affine_opt: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    let group_affine = group_affine_opt.ok_or_else(|| error!(SodaError::InvalidGroupPk))?;

    let tweak_fb: FieldBytes = (*tweak_bytes).into();
    let tweak_opt: Option<Scalar> = Scalar::from_repr(tweak_fb).into();
    let tweak = tweak_opt.ok_or_else(|| error!(SodaError::InvalidTweak))?;

    let group_proj = ProjectivePoint::from(group_affine);
    let tweaked_proj = group_proj + ProjectivePoint::GENERATOR * tweak;
    let tweaked_affine = AffinePoint::from(tweaked_proj);

    let ep_out = tweaked_affine.to_encoded_point(false);
    let bytes = ep_out.as_bytes();
    require_eq!(bytes.len(), 65, SodaError::DerivationFailed);
    let mut out = [0u8; 65];
    out.copy_from_slice(bytes);
    Ok(out)
}

pub fn eth_address_from_pk(uncompressed_pk: &[u8; 65]) -> [u8; 20] {
    let h = keccak::hashv(&[&uncompressed_pk[1..]]).to_bytes();
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&h[12..]);
    addr
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let s = s.trim_start_matches("0x");
        assert_eq!(s.len(), 2 * N, "hex len mismatch: got {}, want {}", s.len(), 2 * N);
        let mut out = [0u8; N];
        for i in 0..N {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    // secp256k1 generator G in compressed SEC1 form.
    const G_COMPRESSED_HEX: &str =
        "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798";

    // 2*G in uncompressed SEC1 form. Standard secp256k1 test vector.
    const TWO_G_UNCOMPRESSED_HEX: &str =
        "04C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5\
         1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A";

    #[test]
    fn tweak_is_deterministic() {
        let prog = [1u8; 32];
        let seeds = b"vault";
        let mut tag = [0u8; 32];
        tag[..16].copy_from_slice(b"ethereum-sepolia");
        assert_eq!(compute_tweak(&prog, seeds, &tag), compute_tweak(&prog, seeds, &tag));
    }

    #[test]
    fn tweak_changes_with_seeds() {
        let prog = [1u8; 32];
        let mut tag = [0u8; 32];
        tag[..16].copy_from_slice(b"ethereum-sepolia");
        assert_ne!(compute_tweak(&prog, b"a", &tag), compute_tweak(&prog, b"b", &tag));
    }

    #[test]
    fn tweak_changes_with_program() {
        let mut tag = [0u8; 32];
        tag[..16].copy_from_slice(b"ethereum-sepolia");
        assert_ne!(
            compute_tweak(&[1u8; 32], b"x", &tag),
            compute_tweak(&[2u8; 32], b"x", &tag)
        );
    }

    #[test]
    fn derive_g_plus_g_equals_2g() {
        // group_pk = G; tweak = 1; foreign_pk = G + 1·G = 2G.
        let g: [u8; 33] = unhex::<33>(G_COMPRESSED_HEX);
        let mut tweak = [0u8; 32];
        tweak[31] = 1;
        let foreign = derive_foreign_pk(&g, &tweak).unwrap();
        let expected: [u8; 65] = unhex::<65>(TWO_G_UNCOMPRESSED_HEX);
        assert_eq!(foreign, expected);
    }

    #[test]
    fn derive_with_zero_tweak_returns_group_pk_uncompressed() {
        // tweak = 0 → foreign_pk = group_pk + 0·G = group_pk.
        let g: [u8; 33] = unhex::<33>(G_COMPRESSED_HEX);
        let zero = [0u8; 32];
        let foreign = derive_foreign_pk(&g, &zero).unwrap();
        // foreign[1..33] must equal G.x (last 32 bytes of compressed G).
        assert_eq!(&foreign[1..33], &g[1..]);
    }

    #[test]
    fn eth_address_is_deterministic_and_nonzero() {
        let pk: [u8; 65] = unhex::<65>(TWO_G_UNCOMPRESSED_HEX);
        let a1 = eth_address_from_pk(&pk);
        let a2 = eth_address_from_pk(&pk);
        assert_eq!(a1, a2);
        assert_ne!(a1, [0u8; 20]);
    }
}
