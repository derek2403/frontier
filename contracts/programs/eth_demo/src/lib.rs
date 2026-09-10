use anchor_lang::prelude::*;
use solana_program::keccak;

pub mod eth_rlp;
pub mod state;

declare_id!("9JMr3TNHk2Mh7TQsaoxkfDmLFE3naYcAwcsgkKv3BBXx");

// The chain is no longer a compile-time constant. `chain_id` and `chain_tag`
// arrive as instruction arguments, so one deployment serves every EVM chain:
// chain_id goes into the EIP-155 RLP (and so into the signed payload), and
// chain_tag goes into the derivation. Letting the caller choose the tag is
// safe — the derivation is still bound to the signer, so a different tag only
// gives the SAME owner a DIFFERENT address, never someone else's.

#[program]
pub mod eth_demo {
    use super::*;

    /// `foreign_pk_xy` is gone: soda now derives the foreign key itself from
    /// the signer, so this program cannot name an address on a user's behalf
    /// and a malicious client cannot name one at all.
    ///
    /// `data` is the transaction calldata. Empty for a plain ETH transfer; a
    /// contract call (e.g. Aave's depositETH) puts its ABI-encoded selector +
    /// args here. The program does not interpret it — it is RLP-encoded into
    /// the payload like any other field, so the signature commits to it.
    pub fn sign_eth_transfer(
        ctx: Context<SignEthTransfer>,
        to: [u8; 20],
        value_wei_be: [u8; 16],
        nonce: u64,
        gas_price_wei: u64,
        gas_limit: u64,
        data: Vec<u8>,
        chain_id: u64,
        chain_tag: [u8; 32],
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
            &data,
            chain_id,
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
                payer: ctx.accounts.user.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        soda::cpi::request_signature(
            cpi_ctx,
            derivation_seeds,
            payload,
            chain_tag,
            0, // domain_id: secp256k1 ECDSA
        )?;

        // 4. Emit the unsigned RLP so the relayer can assemble + broadcast
        //    once the signature lands via SigCompleted.
        emit!(EthTxRequested {
            sig_request: ctx.accounts.sig_request.key(),
            chain_id,
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
