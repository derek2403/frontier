// Build a `soda::finalize_signature` Anchor instruction by hand —
// avoids pulling in the heavy `anchor-client` dep just for one ix.
//
// Anchor IX layout: [8-byte discriminator][borsh-encoded args].
// Discriminator: `sha256("global:finalize_signature")[..8]`.

use anyhow::Result;
use borsh::{to_vec, BorshSerialize};
use sha2::{Digest, Sha256};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

#[derive(BorshSerialize)]
struct FinalizeArgs {
    signature: [u8; 64],
    recovery_id: u8,
}

fn anchor_ix_disc(name: &str) -> [u8; 8] {
    let r = Sha256::digest(format!("global:{name}").as_bytes());
    let mut d = [0u8; 8];
    d.copy_from_slice(&r[..8]);
    d
}

pub fn finalize_signature_ix(
    soda_program_id: &Pubkey,
    committee_pda: &Pubkey,
    sig_request_pda: &Pubkey,
    submitter: &Pubkey,
    signature: [u8; 64],
    recovery_id: u8,
) -> Result<Instruction> {
    let mut data = anchor_ix_disc("finalize_signature").to_vec();
    let args = FinalizeArgs { signature, recovery_id };
    data.extend(to_vec(&args)?);

    let accounts = vec![
        AccountMeta::new_readonly(*committee_pda, false),
        AccountMeta::new(*sig_request_pda, false),
        AccountMeta::new_readonly(*submitter, true),
    ];

    Ok(Instruction {
        program_id: *soda_program_id,
        accounts,
        data,
    })
}
