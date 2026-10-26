//! Usage: inclusion <ledger dir> <slot> <transaction hex>
//! Prints a JSON proof that the transaction bytes are inside the block whose
//! block_id the Alpenglow certificate signs, and checks it end to end.

use {
    serde_json::json,
    sha2::{Digest, Sha256},
    solana_ledger::{
        blockstore::Blockstore,
        blockstore_meta::BlockLocation,
        blockstore_options::{AccessType, BlockstoreOptions},
    },
    std::{env, path::Path},
};

const LEAF: &[u8] = b"\x00SOLANA_MERKLE_SHREDS_LEAF";
const NODE: &[u8] = b"\x01SOLANA_MERKLE_SHREDS_NODE";
const SIG: usize = 64;
const DATA_PAYLOAD: usize = 1203;
const DATA_HEADERS: usize = 88;
const DATA_SHREDS_PER_FEC: u32 = 32;

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
fn join(a: &[u8], b: &[u8]) -> [u8; 32] {
    sha(&[NODE, &a[..20], &b[..20]])
}

/// Agave's MerkleTree: pair neighbours, an odd last node pairs with itself.
fn tree(leaves: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    let mut levels = vec![leaves.to_vec()];
    while levels.last().unwrap().len() > 1 {
        let cur = levels.last().unwrap();
        let next = (0..cur.len())
            .step_by(2)
            .map(|i| join(&cur[i], &cur[(i + 1).min(cur.len() - 1)]))
            .collect();
        levels.push(next);
    }
    levels
}
fn proof(levels: &[Vec<[u8; 32]>], mut index: usize) -> Vec<[u8; 20]> {
    let mut out = vec![];
    for level in &levels[..levels.len() - 1] {
        let sib = (index ^ 1).min(level.len() - 1);
        out.push(level[sib][..20].try_into().unwrap());
        index >>= 1;
    }
    out
}
/// The check a verifier on another chain runs.
fn fold(mut node: [u8; 32], mut index: usize, proof: &[[u8; 20]]) -> [u8; 32] {
    for p in proof {
        node = if index % 2 == 0 { join(&node, p) } else { join(p, &node) };
        index >>= 1;
    }
    node
}

struct DataShred {
    index: u32,
    fec: u32,
    leaf_bytes: Vec<u8>, // payload[64..proof_offset], hashed into the leaf
    proof: Vec<[u8; 20]>,
    data: Vec<u8>, // the block's bytes this shred carries
}

fn parse(p: &[u8]) -> DataShred {
    assert_eq!(p.len(), DATA_PAYLOAD, "not a Merkle data shred");
    let variant = p[SIG];
    assert!(variant & 0xd0 == 0x90, "variant {variant:#x} is not Merkle data");
    let proof_size = (variant & 0x0f) as usize;
    let resigned = variant & 0x20 != 0;
    let proof_offset = DATA_PAYLOAD - proof_size * 20 - if resigned { SIG } else { 0 };
    let index = u32::from_le_bytes(p[73..77].try_into().unwrap());
    let fec = u32::from_le_bytes(p[79..83].try_into().unwrap());
    let size = u16::from_le_bytes(p[86..88].try_into().unwrap()) as usize;
    DataShred {
        index,
        fec,
        leaf_bytes: p[SIG..proof_offset].to_vec(),
        proof: p[proof_offset..proof_offset + proof_size * 20]
            .chunks(20)
            .map(|c| c.try_into().unwrap())
            .collect(),
        data: p[DATA_HEADERS..size].to_vec(),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let (ledger, slot, tx) = (&args[1], args[2].parse::<u64>().unwrap(), hex::decode(&args[3]).unwrap());

    let bs = Blockstore::open_with_options(
        Path::new(ledger),
        // A read-only snapshot taken now, while the node keeps writing.
        BlockstoreOptions { access_type: AccessType::ReadOnly, ..BlockstoreOptions::default() },
    )
    .expect("open blockstore");

    let meta = bs.meta(slot).unwrap().expect("slot meta");
    let parent_slot = meta.parent_slot.expect("parent slot");
    let parent_block_id = bs
        .get_double_merkle_root(parent_slot, BlockLocation::Original)
        .unwrap()
        .expect("parent block_id");
    let stored_block_id = bs
        .get_double_merkle_root(slot, BlockLocation::Original)
        .unwrap()
        .expect("block_id");

    let shreds: Vec<DataShred> = bs
        .get_data_shreds_for_slot(slot, 0)
        .unwrap()
        .iter()
        .map(|s| parse(s.payload().as_ref()))
        .collect();
    let last_index = meta.last_index.expect("slot full") as u32;
    assert_eq!(shreds.len() as u32, last_index + 1, "missing data shreds");
    let fec_count = last_index / DATA_SHREDS_PER_FEC + 1;

    // 1. Each data shred proves itself up to its FEC set root.
    let fec_root = |s: &DataShred| fold(sha(&[LEAF, &s.leaf_bytes]), (s.index - s.fec) as usize, &s.proof);
    let mut fec_roots = vec![[0u8; 32]; fec_count as usize];
    for s in &shreds {
        let r = fec_root(s);
        let k = (s.fec / DATA_SHREDS_PER_FEC) as usize;
        if s.index == s.fec {
            fec_roots[k] = r;
        } else {
            assert_eq!(fec_roots[k], r, "shreds of one FEC set disagree on the root");
        }
    }

    // 2. Double Merkle tree: FEC set roots, then the parent leaf.
    let mut leaves = fec_roots.clone();
    leaves.push(sha(&[&parent_slot.to_le_bytes(), parent_block_id.as_ref(), &fec_count.to_le_bytes()]));
    let levels = tree(&leaves);
    let block_id = *levels.last().unwrap().first().unwrap();

    // 3. Find the transaction in the block's byte stream.
    let mut stream = vec![];
    let mut starts = vec![];
    for s in &shreds {
        starts.push(stream.len());
        stream.extend_from_slice(&s.data);
    }
    let at = stream.windows(tx.len()).position(|w| w == tx.as_slice()).expect("transaction not in block");
    let first = starts.iter().rposition(|&o| o <= at).unwrap();
    let last = starts.iter().rposition(|&o| o < at + tx.len()).unwrap();

    // 4. The proof for those shreds, and the same check a verifier would run.
    let proof_shreds: Vec<_> = (first..=last)
        .map(|i| {
            let s = &shreds[i];
            let k = (s.fec / DATA_SHREDS_PER_FEC) as usize;
            let double = proof(&levels, k);
            let root = fold(fold(sha(&[LEAF, &s.leaf_bytes]), (s.index - s.fec) as usize, &s.proof), k, &double);
            assert_eq!(root, block_id, "proof does not reach block_id");
            json!({
                "index": s.index,
                "fecSetIndex": s.fec,
                "leafBytes": hex::encode(&s.leaf_bytes),
                "shredProof": s.proof.iter().map(hex::encode).collect::<Vec<_>>(),
                "doubleProof": double.iter().map(hex::encode).collect::<Vec<_>>(),
                "dataStartInStream": starts[i],
                "dataLen": s.data.len(),
            })
        })
        .collect();

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "slot": slot,
            "parentSlot": parent_slot,
            "parentBlockId": hex::encode(parent_block_id),
            "fecSetCount": fec_count,
            "dataShreds": shreds.len(),
            "blockIdRecomputed": hex::encode(block_id),
            "blockIdStored": hex::encode(stored_block_id),
            "match": block_id.as_slice() == stored_block_id.as_ref(),
            "txOffsetInStream": at,
            "txLen": tx.len(),
            "shreds": proof_shreds,
        }))
        .unwrap()
    );
}
