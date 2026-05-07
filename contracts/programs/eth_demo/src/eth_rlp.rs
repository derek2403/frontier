// Minimal RLP encoder for the 9-field legacy Ethereum tx (EIP-155 unsigned form).
//
//   RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
//   sighash = keccak256(rlp_bytes)
//
// Pure function — must match TS SDK byte-for-byte.

fn trim_leading_zeros(b: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < b.len() && b[i] == 0 {
        i += 1;
    }
    &b[i..]
}

/// RLP-encode a byte string element.
///   single byte < 0x80           → byte itself
///   0..=55 bytes                 → 0x80 + len, then bytes
///   56..=255 bytes               → 0xb8, len (1 byte), then bytes
fn encode_bytes(bytes: &[u8], out: &mut Vec<u8>) {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        out.push(bytes[0]);
    } else if bytes.len() <= 55 {
        out.push(0x80 + bytes.len() as u8);
        out.extend_from_slice(bytes);
    } else {
        // Single-tx fields never exceed 55 bytes (a 20-byte address is the max).
        // Guard the contract anyway.
        debug_assert!(bytes.len() <= 255);
        out.push(0xb8);
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
}

fn encode_u64(n: u64, out: &mut Vec<u8>) {
    let bytes = n.to_be_bytes();
    encode_bytes(trim_leading_zeros(&bytes), out);
}

fn encode_u128_be(value_be: &[u8; 16], out: &mut Vec<u8>) {
    encode_bytes(trim_leading_zeros(value_be), out);
}

/// Wrap an RLP payload as a list:
///   0..=55 bytes                 → 0xc0 + len, then payload
///   56..=255 bytes               → 0xf8, len (1 byte), then payload
///   256..=65535 bytes            → 0xf9, len (2 bytes BE), then payload
fn wrap_list(payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    if payload.len() <= 55 {
        out.push(0xc0 + payload.len() as u8);
    } else if payload.len() <= 255 {
        out.push(0xf8);
        out.push(payload.len() as u8);
    } else {
        let len_be = (payload.len() as u16).to_be_bytes();
        out.push(0xf9);
        out.extend_from_slice(&len_be);
    }
    out.extend(payload);
    out
}

pub fn encode_unsigned_legacy(
    nonce: u64,
    gas_price_wei: u64,
    gas_limit: u64,
    to: &[u8; 20],
    value_wei_be: &[u8; 16],
    data: &[u8],
    chain_id: u64,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(96);
    encode_u64(nonce, &mut payload);
    encode_u64(gas_price_wei, &mut payload);
    encode_u64(gas_limit, &mut payload);
    encode_bytes(to, &mut payload);
    encode_u128_be(value_wei_be, &mut payload);
    encode_bytes(data, &mut payload);
    encode_u64(chain_id, &mut payload);
    encode_bytes(&[], &mut payload); // r placeholder = 0
    encode_bytes(&[], &mut payload); // s placeholder = 0
    wrap_list(payload)
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

    #[test]
    fn empty_string_is_0x80() {
        let mut out = Vec::new();
        encode_bytes(&[], &mut out);
        assert_eq!(out, vec![0x80]);
    }

    #[test]
    fn single_low_byte_is_itself() {
        let mut out = Vec::new();
        encode_bytes(&[0x7f], &mut out);
        assert_eq!(out, vec![0x7f]);
    }

    #[test]
    fn single_high_byte_uses_string_prefix() {
        let mut out = Vec::new();
        encode_bytes(&[0x80], &mut out);
        assert_eq!(out, vec![0x81, 0x80]);
    }

    #[test]
    fn u64_zero_encodes_empty_string() {
        let mut out = Vec::new();
        encode_u64(0, &mut out);
        assert_eq!(out, vec![0x80]);
    }

    #[test]
    fn u64_one_encodes_as_single_byte() {
        let mut out = Vec::new();
        encode_u64(1, &mut out);
        assert_eq!(out, vec![0x01]);
    }

    /// EIP-155 spec example: nonce=9, gasPrice=20Gwei, gasLimit=21000,
    /// to=0x3535...3535, value=1 ETH, data="", chainId=1.
    /// RLP unsigned bytes per the spec / public test vectors.
    #[test]
    fn eip155_canonical_vector() {
        let to = [0x35u8; 20];
        let value: u128 = 1_000_000_000_000_000_000; // 1 ETH
        let value_be = value.to_be_bytes();
        let rlp = encode_unsigned_legacy(
            9,
            20_000_000_000, // 20 Gwei
            21_000,
            &to,
            &value_be,
            &[],
            1, // mainnet
        );
        let expected = unhex(
            "ec098504a817c800825208943535353535353535353535353535353535353535\
             880de0b6b3a764000080018080",
        );
        assert_eq!(rlp, expected, "RLP mismatch");
    }

    #[test]
    fn sepolia_value_transfer_shape() {
        let to = [0xaau8; 20];
        let value_be: [u8; 16] = 1_000_000_000_000_000u128.to_be_bytes(); // 0.001 ETH
        let rlp = encode_unsigned_legacy(0, 10_000_000_000, 21_000, &to, &value_be, &[], 11_155_111);
        // List prefix
        assert!(rlp[0] >= 0xc0, "first byte should be a list prefix");
        // Trailing r=s=0 → two 0x80 bytes (chainId precedes them as a non-empty string).
        assert_eq!(&rlp[rlp.len() - 2..], &[0x80, 0x80]);
    }

    #[test]
    fn chain_id_minimal_be_for_sepolia() {
        // Sepolia chainId = 11_155_111 = 0x00aa36a7. Trimmed → 0xaa36a7 (3 bytes).
        // encode_u64 → 0x83 aa 36 a7
        let mut out = Vec::new();
        encode_u64(11_155_111, &mut out);
        assert_eq!(out, vec![0x83, 0xaa, 0x36, 0xa7]);
    }
}
