use anchor_lang::prelude::*;

use crate::state::Committee;

#[derive(Accounts)]
pub struct InitCommittee<'info> {
    #[account(
        init,
        payer = authority,
        space = Committee::SIZE,
        seeds = [b"committee"],
        bump,
    )]
    pub committee: Account<'info, Committee>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitCommittee>, group_pk: [u8; 33]) -> Result<()> {
    let committee = &mut ctx.accounts.committee;
    committee.bump = ctx.bumps.committee;
    committee.authority = ctx.accounts.authority.key();
    committee.group_pk = group_pk;
    committee.signer_count = 1;
    Ok(())
}
