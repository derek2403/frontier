use anchor_lang::prelude::*;

use crate::state::Committee;

/// Authority-only update of `group_pk`. Used when migrating from a v0
/// single-key signer to a v0.5+ MPC committee that produced a fresh joint
/// public key via DKG, without re-deploying the program.
///
/// `signer_count` is bumped at the same time so the on-chain account
/// reflects the new committee size (e.g. 2 for 2-of-2 Lindell '17).
#[derive(Accounts)]
pub struct UpdateCommittee<'info> {
    #[account(
        mut,
        seeds = [b"committee"],
        bump = committee.bump,
        has_one = authority,
    )]
    pub committee: Account<'info, Committee>,
    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateCommittee>,
    new_group_pk: [u8; 33],
    new_signer_count: u8,
) -> Result<()> {
    let committee = &mut ctx.accounts.committee;
    committee.group_pk = new_group_pk;
    committee.signer_count = new_signer_count;
    Ok(())
}
