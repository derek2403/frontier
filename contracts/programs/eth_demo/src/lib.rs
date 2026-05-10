use anchor_lang::prelude::*;
use solana_program::keccak;

pub mod eth_rlp;
pub mod state;

declare_id!("9g9eAkNbjpkVLi692vhgcUapJKS26yQTgsLzKbXKJXWM");

pub const ETH_SEPOLIA_CHAIN_ID: u64 = 11_155_111;

/// 32-byte ASCII chain tag, right-padded with zeros: "ethereum-sepolia\0..."
pub const fn eth_sepolia_chain_tag() -> [u8; 32] {
    let mut tag = [0u8; 32];
    let s = b"ethereum-sepolia";
    let mut i = 0;
    while i < s.len() {
        tag[i] = s[i];
        i += 1;
    }
    tag
}

#[program]
pub mod eth_demo {
    use super::*;

    pub fn sign_eth_transfer(
        ctx: Context<SignEthTransfer>,
        foreign_pk_xy: [u8; 64],
        to: [u8; 20],
        value_wei_be: [u8; 16],
        nonce: u64,
        gas_price_wei: u64,
        gas_limit: u64,
        derivation_seeds: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.soda_program.key(), soda::ID);

        // 1. Build unsigned RLP for the legacy + EIP-155 tx.
        let unsigned_rlp = eth_rlp::encode_unsigned_legacy(
            nonce,
            gas_price_wei,
            gas_limit,
            &to,
            &value_wei_be,
            &[],
            ETH_SEPOLIA_CHAIN_ID,
        );

        // 2. keccak256 sighash — this is what the signer needs to sign.
        let payload = keccak::hashv(&[&unsigned_rlp]).to_bytes();

        // 3. CPI soda::request_signature.
        let cpi_ctx = CpiContext::new(
            ctx.accounts.soda_program.to_account_info(),
            soda::cpi::accounts::RequestSignature {
                committee: ctx.accounts.committee.to_account_info(),
                sig_request: ctx.accounts.sig_request.to_account_info(),
                requester: ctx.accounts.user.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        soda::cpi::request_signature(
            cpi_ctx,
            foreign_pk_xy,
            derivation_seeds,
            payload,
            eth_sepolia_chain_tag(),
        )?;

        // 4. Emit the unsigned RLP so the relayer can assemble + broadcast
        //    once the signature lands via SigCompleted.
        emit!(EthTxRequested {
            sig_request: ctx.accounts.sig_request.key(),
            chain_id: ETH_SEPOLIA_CHAIN_ID,
            unsigned_rlp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SignEthTransfer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: passed through to soda CPI; soda verifies seeds + bump.
    pub committee: UncheckedAccount<'info>,
    /// CHECK: initialized via the soda CPI as a SigRequest PDA.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: validated against soda::ID inside the handler.
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct EthTxRequested {
    pub sig_request: Pubkey,
    pub chain_id: u64,
    pub unsigned_rlp: Vec<u8>,
}
