use anchor_lang::prelude::*;

#[account]
pub struct PendingTx {
    pub bump: u8,
    pub requester: Pubkey,
    pub sig_request: Pubkey,
    pub unsigned_rlp: Vec<u8>,
}

impl PendingTx {
    pub const MAX_RLP_LEN: usize = 256;
    pub const SIZE: usize = 8 + 1 + 32 + 32 + (4 + Self::MAX_RLP_LEN);
}
