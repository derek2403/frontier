//! BLAKE2b-256, as Sui uses it for addresses and transaction digests.
//!
//! Solana has syscalls for sha256, keccak256 and blake3 but not blake2, so
//! this is a direct implementation of RFC 7693 with the parameter block for
//! an unkeyed 32-byte digest. One compression is ~1.2k 64-bit operations,
//! and a Sui transfer is two or three blocks, so the whole thing costs a
//! fraction of one `secp256k1_recover`.
//!
//! Arithmetic is explicitly wrapping: the workspace builds programs with
//! `overflow-checks = true`, and every add in BLAKE2 is meant to wrap.
//!
//! Vectors in the tests were produced by `@noble/hashes` `blake2b(x, { dkLen: 32 })`,
//! the same function `@mysten/sui` calls.

const IV: [u64; 8] = [
    0x6a09_e667_f3bc_c908,
    0xbb67_ae85_84ca_a73b,
    0x3c6e_f372_fe94_f82b,
    0xa54f_f53a_5f1d_36f1,
    0x510e_527f_ade6_82d1,
    0x9b05_688c_2b3e_6c1f,
    0x1f83_d9ab_fb41_bd6b,
    0x5be0_cd19_137e_2179,
];

const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const BLOCK_LEN: usize = 128;
const OUT_LEN: usize = 32;

#[inline(always)]
fn g(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

/// One compression. `t` is the number of input bytes consumed so far
/// INCLUDING this block; `last` marks the final block.
fn compress(h: &mut [u64; 8], block: &[u8; BLOCK_LEN], t: u64, last: bool) {
    let mut m = [0u64; 16];
    for (i, word) in m.iter_mut().enumerate() {
        let mut w = [0u8; 8];
        w.copy_from_slice(&block[i * 8..i * 8 + 8]);
        *word = u64::from_le_bytes(w);
    }

    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= t;
    // v[13] carries the high 64 bits of the counter; inputs here are far
    // below 2^64 bytes.
    if last {
        v[14] = !v[14];
    }

    for s in SIGMA.iter() {
        g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }

    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

/// BLAKE2b with a 32-byte digest and no key.
pub fn blake2b_256(data: &[u8]) -> [u8; OUT_LEN] {
    let mut h = IV;
    // Parameter block word 0: digest_length | key_length << 8 | fanout << 16 | depth << 24.
    h[0] ^= 0x0101_0000 ^ (OUT_LEN as u64);

    let mut block = [0u8; BLOCK_LEN];
    let mut t: u64 = 0;

    if data.is_empty() {
        compress(&mut h, &block, 0, true);
    } else {
        // Every block but the last is full; the last may be full too.
        let full_blocks = (data.len() - 1) / BLOCK_LEN;
        for i in 0..full_blocks {
            block.copy_from_slice(&data[i * BLOCK_LEN..(i + 1) * BLOCK_LEN]);
            t += BLOCK_LEN as u64;
            compress(&mut h, &block, t, false);
        }
        let rest = &data[full_blocks * BLOCK_LEN..];
        block = [0u8; BLOCK_LEN];
        block[..rest.len()].copy_from_slice(rest);
        t += rest.len() as u64;
        compress(&mut h, &block, t, true);
    }

    let mut out = [0u8; OUT_LEN];
    for i in 0..4 {
        out[i * 8..i * 8 + 8].copy_from_slice(&h[i].to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    #[test]
    fn empty_input() {
        assert_eq!(
            hex(&blake2b_256(b"")),
            "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
    }

    #[test]
    fn abc() {
        assert_eq!(
            hex(&blake2b_256(b"abc")),
            "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"
        );
    }

    /// Block boundaries: 127 (one partial), 128 (exactly one full block,
    /// which must still be the *last* block), 129 (one full + one partial).
    #[test]
    fn around_the_block_boundary() {
        let b127: Vec<u8> = (0..127u8).collect();
        let b128: Vec<u8> = (0..128u8).collect();
        let b129: Vec<u8> = (0..=128u8).collect();
        assert_eq!(
            hex(&blake2b_256(&b127)),
            "f2fe67ff342e21b8f45e8f2e0bcd1d9243245d50ee6c78042e9c491388791c72"
        );
        assert_eq!(
            hex(&blake2b_256(&b128)),
            "c3582f71ebb2be66fa5dd750f80baae97554f3b015663c8be377cfcb2488c1d1"
        );
        assert_eq!(
            hex(&blake2b_256(&b129)),
            "f7f3c46ba2564ff4c4c162da1f5b605f9f1c4aa6a20652a9f9a337c1a2f5b9c9"
        );
    }

    #[test]
    fn multi_block_inputs() {
        let b256: Vec<u8> = (0..256usize).map(|i| ((i * 7) & 0xff) as u8).collect();
        let b300: Vec<u8> = (0..300usize).map(|i| ((i * 13 + 5) & 0xff) as u8).collect();
        assert_eq!(
            hex(&blake2b_256(&b256)),
            "3d0cb2693dfbac42af5a6cc960953fea8714aa39c4bcd054ef61d6b5e98ade4a"
        );
        assert_eq!(
            hex(&blake2b_256(&b300)),
            "36fa0e07b98dfc667ce12910712bcb272c29b2f8b1ed559ed65fbb27ad640109"
        );
    }
}
