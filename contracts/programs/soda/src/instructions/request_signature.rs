use anchor_lang::prelude::*;

use crate::derive_onchain::{compute_tweak, derive_foreign_pk_xy};
use crate::errors::SodaError;
use crate::state::{Committee, SigRequest, SigRequested};

/// Signature schemes. Only secp256k1 ECDSA exists today; the field is here so
/// that adding an Ed25519 committee later is additive rather than a breaking
/// change to this instruction. Mirrors NEAR's `domain_id`.
pub const DOMAIN_SECP256K1_ECDSA: u32 = 0;

#[derive(Accounts)]
#[instruction(derivation_seeds: Vec<u8>, payload: [u8; 32], chain_tag: [u8; 32], domain_id: u32)]
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

/// Create a signature request.
///
/// The caller does NOT supply a public key. This program derives
/// `foreign_pk = group_pk + tweak*G` itself, where the tweak is keyed on the
/// *signer* — so a caller cannot request a signature for an address it does
/// not control, and "this account owns this foreign address" becomes a fact
/// the chain enforces rather than a convention the client follows.
///
/// Because the tweak is keyed on `requester.key()`, both models work through
/// one mechanism: a wallet signing directly owns its own foreign address, and
/// a program CPI-ing with `invoke_signed` owns one under its PDA.
pub fn handler(
    ctx: Context<RequestSignature>,
    derivation_seeds: Vec<u8>,
    payload: [u8; 32],
    chain_tag: [u8; 32],
    domain_id: u32,
) -> Result<()> {
    require!(
        derivation_seeds.len() <= SigRequest::MAX_SEEDS_LEN,
        SodaError::SeedsTooLong
    );
    require!(
        domain_id == DOMAIN_SECP256K1_ECDSA,
        SodaError::UnsupportedDomain
    );

    let requester_key = ctx.accounts.requester.key();
    let group_pk = ctx.accounts.committee.group_pk;

    let tweak = compute_tweak(&requester_key.to_bytes(), &derivation_seeds, &chain_tag);
    let foreign_pk_xy = derive_foreign_pk_xy(&group_pk, &tweak)?;

    msg!("derived foreign_pk on-chain from requester + seeds + chain_tag");

    let sig_request = &mut ctx.accounts.sig_request;
    sig_request.bump = ctx.bumps.sig_request;
    sig_request.requester = requester_key;
    sig_request.committee = ctx.accounts.committee.key();
    sig_request.foreign_pk_xy = foreign_pk_xy;
    sig_request.derivation_seeds = derivation_seeds.clone();
    sig_request.payload = payload;
    sig_request.chain_tag = chain_tag;
    sig_request.domain_id = domain_id;
    sig_request.expires_at = Clock::get()?.unix_timestamp + 300;
    sig_request.completed = false;
    sig_request.signature = [0u8; 64];
    sig_request.recovery_id = 0;

    emit!(SigRequested {
        sig_request: sig_request.key(),
        requester: requester_key,
        foreign_pk_xy,
        payload,
        chain_tag,
        derivation_seeds,
        domain_id,
    });

    Ok(())
}
