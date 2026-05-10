use anchor_lang::prelude::*;

use crate::errors::SodaError;
use crate::state::{Committee, SigRequest, SigRequested};

#[derive(Accounts)]
#[instruction(foreign_pk_xy: [u8; 64], derivation_seeds: Vec<u8>, payload: [u8; 32], chain_tag: [u8; 32])]
pub struct RequestSignature<'info> {
    #[account(seeds = [b"committee"], bump = committee.bump)]
    pub committee: Account<'info, Committee>,
    #[account(
        init,
        payer = requester,
        space = SigRequest::SIZE,
        seeds = [b"sig", requester.key().as_ref(), &payload],
        bump,
    )]
    pub sig_request: Account<'info, SigRequest>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RequestSignature>,
    foreign_pk_xy: [u8; 64],
    derivation_seeds: Vec<u8>,
    payload: [u8; 32],
    chain_tag: [u8; 32],
) -> Result<()> {
    require!(
        derivation_seeds.len() <= SigRequest::MAX_SEEDS_LEN,
        SodaError::SeedsTooLong
    );

    let sig_request = &mut ctx.accounts.sig_request;
    sig_request.bump = ctx.bumps.sig_request;
    sig_request.requester = ctx.accounts.requester.key();
    sig_request.committee = ctx.accounts.committee.key();
    sig_request.foreign_pk_xy = foreign_pk_xy;
    sig_request.derivation_seeds = derivation_seeds.clone();
    sig_request.payload = payload;
    sig_request.chain_tag = chain_tag;
    sig_request.expires_at = Clock::get()?.unix_timestamp + 300;
    sig_request.completed = false;
    sig_request.signature = [0u8; 64];
    sig_request.recovery_id = 0;

    emit!(SigRequested {
        sig_request: sig_request.key(),
        requester: ctx.accounts.requester.key(),
        foreign_pk_xy,
        payload,
        chain_tag,
        derivation_seeds,
    });

    Ok(())
}
