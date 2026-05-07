use anchor_lang::prelude::*;

#[account]
pub struct Committee {
    pub bump: u8,
    pub authority: Pubkey,
    pub group_pk: [u8; 33],
    pub signer_count: u8,
}

impl Committee {
    pub const SIZE: usize = 8 + 1 + 32 + 33 + 1;
}

/// Caller-provided expected pubkey: 64-byte (X || Y) form, matching what
/// `secp256k1_recover` returns. Caller computes this off-chain via
/// `group_pk + tweak·G` and is bound by the resulting derivation: any
/// signature produced for a foreign_pk the signer doesn't own (= no one
/// holds `group_sk + tweak`) will simply never verify.
#[account]
pub struct SigRequest {
    pub bump: u8,
    pub requester: Pubkey,
    pub committee: Pubkey,
    pub foreign_pk_xy: [u8; 64],
    pub derivation_seeds: Vec<u8>,
    pub payload: [u8; 32],
    pub chain_tag: [u8; 32],
    pub expires_at: i64,
    pub completed: bool,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}

impl SigRequest {
    pub const MAX_SEEDS_LEN: usize = 64;
    pub const SIZE: usize =
        8 + 1 + 32 + 32 + 64 + (4 + Self::MAX_SEEDS_LEN) + 32 + 32 + 8 + 1 + 64 + 1;
}

#[event]
pub struct SigRequested {
    pub sig_request: Pubkey,
    pub requester: Pubkey,
    pub foreign_pk_xy: [u8; 64],
    pub payload: [u8; 32],
    pub chain_tag: [u8; 32],
    pub derivation_seeds: Vec<u8>,
}

#[event]
pub struct SigCompleted {
    pub sig_request: Pubkey,
    pub signature: [u8; 64],
    pub recovery_id: u8,
}
