use anchor_lang::prelude::*;

#[cfg(test)]
mod derivation;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("99apYWpnoMWwA2iXyJZcTMoTEag6tdFasjujdhdeG8b4");

#[program]
pub mod soda {
    use super::*;

    pub fn init_committee(ctx: Context<InitCommittee>, group_pk: [u8; 33]) -> Result<()> {
        instructions::init_committee::handler(ctx, group_pk)
    }

    pub fn request_signature(
        ctx: Context<RequestSignature>,
        foreign_pk_xy: [u8; 64],
        derivation_seeds: Vec<u8>,
        payload: [u8; 32],
        chain_tag: [u8; 32],
    ) -> Result<()> {
        instructions::request_signature::handler(
            ctx,
            foreign_pk_xy,
            derivation_seeds,
            payload,
            chain_tag,
        )
    }

    pub fn finalize_signature(
        ctx: Context<FinalizeSignature>,
        signature: [u8; 64],
        recovery_id: u8,
    ) -> Result<()> {
        instructions::finalize_signature::handler(ctx, signature, recovery_id)
    }
}
