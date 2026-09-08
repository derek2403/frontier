use anchor_lang::prelude::*;

#[cfg(test)]
mod derivation;
pub mod derive_onchain;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("CPAEfBXpMMsUrjLNhDYxaCH79DYvFHJFC27fttnxAL1J");

#[program]
pub mod soda {
    use super::*;

    pub fn init_committee(ctx: Context<InitCommittee>, group_pk: [u8; 33]) -> Result<()> {
        instructions::init_committee::handler(ctx, group_pk)
    }

    /// Note there is no `foreign_pk_xy` parameter: the program derives the
    /// foreign public key itself from the signer, so a caller cannot name an
    /// address it does not control.
    pub fn request_signature(
        ctx: Context<RequestSignature>,
        derivation_seeds: Vec<u8>,
        payload: [u8; 32],
        chain_tag: [u8; 32],
        domain_id: u32,
    ) -> Result<()> {
        instructions::request_signature::handler(
            ctx,
            derivation_seeds,
            payload,
            chain_tag,
            domain_id,
        )
    }

    pub fn finalize_signature(
        ctx: Context<FinalizeSignature>,
        signature: [u8; 64],
        recovery_id: u8,
    ) -> Result<()> {
        instructions::finalize_signature::handler(ctx, signature, recovery_id)
    }

    pub fn update_committee(
        ctx: Context<UpdateCommittee>,
        new_group_pk: [u8; 33],
        new_signer_count: u8,
    ) -> Result<()> {
        instructions::update_committee::handler(ctx, new_group_pk, new_signer_count)
    }
}
