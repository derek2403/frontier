// SODA derivation, off-chain Rust port. Must match contracts/programs/soda/src/derivation.rs
// and packages/soda-sdk/src/derive.ts byte-for-byte.

use anyhow::{anyhow, Result};
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

pub const DERIVATION_DOMAIN: &[u8] = b"SODA-v1";

pub fn compute_tweak(
    requester_program: &[u8; 32],
    seeds: &[u8],
    chain_tag: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DERIVATION_DOMAIN);
    h.update(requester_program);
    h.update(seeds);
    h.update(chain_tag);
    h.finalize().into()
}

/// `foreign_pk = group_pk + tweak·G` returned in the 64-byte X||Y form (no
/// 0x04 prefix), matching what `secp256k1_recover` returns and what the
/// on-chain `SigRequest.foreign_pk_xy` stores.
pub fn derive_foreign_pk_xy(
    group_pk_compressed: &[u8; 33],
    tweak: &[u8; 32],
) -> Result<[u8; 64]> {
    let ep = EncodedPoint::from_bytes(group_pk_compressed)
        .map_err(|e| anyhow!("invalid group pk: {e}"))?;
    let group_affine_opt: Option<AffinePoint> = AffinePoint::from_encoded_point(&ep).into();
    let group_affine = group_affine_opt.ok_or_else(|| anyhow!("group pk not on curve"))?;

    let tweak_fb: FieldBytes = (*tweak).into();
    let tweak_scalar_opt: Option<Scalar> = Scalar::from_repr(tweak_fb).into();
    let tweak_scalar = tweak_scalar_opt.ok_or_else(|| anyhow!("tweak >= curve order n"))?;

    let group_proj = ProjectivePoint::from(group_affine);
    let tweaked_proj = group_proj + ProjectivePoint::GENERATOR * tweak_scalar;
    let tweaked_affine = AffinePoint::from(tweaked_proj);

    let ep_out = tweaked_affine.to_encoded_point(false);
    let bytes = ep_out.as_bytes();
    if bytes.len() != 65 {
        return Err(anyhow!("uncompressed encoded point not 65 bytes (got {})", bytes.len()));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes[1..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        let s = s.trim_start_matches("0x");
        assert_eq!(s.len(), 2 * N);
        let mut out = [0u8; N];
        for i in 0..N {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn g_plus_g_equals_2g() {
        let g: [u8; 33] = unhex::<33>(
            "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
        );
        let mut tweak = [0u8; 32];
        tweak[31] = 1;
        let xy = derive_foreign_pk_xy(&g, &tweak).unwrap();
        // 2G uncompressed[1..] = X||Y
        let expected: [u8; 64] = unhex::<64>(
            "C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5\
             1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A",
        );
        assert_eq!(xy, expected);
    }
}
