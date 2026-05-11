use anchor_lang::prelude::*;
use solana_program::secp256k1_recover::secp256k1_recover;

use crate::errors::SodaError;
use crate::state::{Committee, SigCompleted, SigRequest};

#[derive(Accounts)]
pub struct FinalizeSignature<'info> {
    #[account(seeds = [b"committee"], bump = committee.bump)]
    pub committee: Account<'info, Committee>,
    #[account(
        mut,
        seeds = [b"sig", sig_request.requester.as_ref(), &sig_request.payload],
        bump = sig_request.bump,
    )]
    pub sig_request: Account<'info, SigRequest>,
    pub submitter: Signer<'info>,
}

pub fn handler(
    ctx: Context<FinalizeSignature>,
    signature: [u8; 64],
    recovery_id: u8,
) -> Result<()> {
    let sig_request = &mut ctx.accounts.sig_request;
    let _ = &ctx.accounts.committee; // committee referenced via PDA constraint

    require!(!sig_request.completed, SodaError::AlreadyCompleted);
    require!(recovery_id <= 1, SodaError::InvalidRecoveryId);

    msg!("verifying MPC signature on-chain via secp256k1_recover...");

    // Recover the pubkey that produced this signature over the payload.
    let recovered = secp256k1_recover(&sig_request.payload, recovery_id, &signature)
        .map_err(|_| error!(SodaError::RecoverFailed))?;

    // Compare against the foreign_pk the requester committed to at request time.
    // If the signer didn't actually hold the secret key for that foreign_pk, the
    // recovered bytes will not match and the request stays incomplete.
    require!(
        recovered.to_bytes() == sig_request.foreign_pk_xy,
        SodaError::PubkeyMismatch
    );

    msg!("secp256k1_recover OK -- signature matches stored foreign_pk_xy");

    sig_request.signature = signature;
    sig_request.recovery_id = recovery_id;
    sig_request.completed = true;

    emit!(SigCompleted {
        sig_request: sig_request.key(),
        signature,
        recovery_id,
    });

    Ok(())
}
