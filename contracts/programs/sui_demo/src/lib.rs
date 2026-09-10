//! sui_demo — the Sui caller of the SODA primitive.
//!
//! Same shape as `eth_demo`: the program builds the foreign transaction
//! itself, hashes it the way the foreign chain will, and commits that hash
//! through `soda::request_signature`. Two things differ from the EVM path
//! and both live here rather than in soda:
//!
//!   * Sui puts the SENDER inside the signed bytes, so the program derives
//!     the signer's Sui address before the CPI (soda derives the same key
//!     again inside; they agree by construction).
//!   * Sui hashes with blake2b, which has no Solana syscall, so a small
//!     implementation ships in this crate.
//!
//! The primitive is unchanged: one secp256k1 key per Solana account, one
//! `secp256k1_recover` check in `finalize_signature`, and Sui accepts the
//! resulting signature as its own secp256k1 scheme (flag 0x01).

use anchor_lang::prelude::*;

pub mod blake2b;
pub mod sui_bcs;

use soda::derive_onchain::{compute_tweak, derive_foreign_pk_xy};
use soda::state::Committee;
use sui_bcs::SuiObjectRef;

declare_id!("9LBE5dntoLRV61AM3W3ZHikgZPqZ5MLS4xCVvSxxbXug");

/// Sui merges every listed gas coin into the first at execution, so passing
/// several lets a fragmented balance pay. Kept small so instruction data
/// stays well inside the transaction size limit.
pub const MAX_GAS_COINS: usize = 4;
/// A PTB with a few Move calls is a few hundred bytes (the DeepBook swap the
/// demo sends is 427).
///
/// The cap is set by what a Solana transaction can carry, not by anything
/// on-chain: kind_bytes is raw instruction data, which no address lookup
/// table can compress. Inside the 1232-byte limit, after the signature,
/// header, seven account keys, blockhash and the compute-budget
/// instruction, roughly 880 bytes are left for this instruction's data, and
/// the fixed fields plus `MAX_GAS_COINS` object refs take about 350 of
/// them. 640 leaves the margin thin but real with four gas coins and
/// comfortable with two; a larger block has to arrive some other way.
pub const MAX_KIND_LEN: usize = 640;

#[program]
pub mod sui_demo {
    use super::*;

    /// Send `amount_mist` of SUI from the signer's derived Sui address to
    /// `recipient`. The program builds the whole transaction — the PTB, the
    /// sender, the gas envelope — so the caller supplies only the recipient,
    /// the amount and the gas coins it read from a Sui node. What Phantom
    /// shows is what will happen.
    pub fn sign_sui_transfer(
        ctx: Context<SignSuiTx>,
        recipient: [u8; 32],
        amount_mist: u64,
        gas_payment: Vec<SuiObjectRef>,
        gas_price: u64,
        gas_budget: u64,
        chain_tag: [u8; 32],
        derivation_seeds: Vec<u8>,
    ) -> Result<()> {
        let kind = sui_bcs::encode_transfer_kind(&recipient, amount_mist);
        commit(&ctx.accounts, kind, gas_payment, gas_price, gas_budget, chain_tag, derivation_seeds)
    }

    /// Any Sui transaction. `kind_bytes` is a BCS `TransactionKind` holding a
    /// ProgrammableTransaction (for example `@mysten/sui`'s
    /// `Transaction.build({ onlyTransactionKind: true })`); the program wraps
    /// it in the same envelope as above. Move calls, DeFi, NFTs — the
    /// primitive does not interpret the commands. It guarantees only that
    /// the signer authorised exactly these bytes and that the derived
    /// address is the sender.
    pub fn sign_sui_tx(
        ctx: Context<SignSuiTx>,
        kind_bytes: Vec<u8>,
        gas_payment: Vec<SuiObjectRef>,
        gas_price: u64,
        gas_budget: u64,
        chain_tag: [u8; 32],
        derivation_seeds: Vec<u8>,
    ) -> Result<()> {
        commit(&ctx.accounts, kind_bytes, gas_payment, gas_price, gas_budget, chain_tag, derivation_seeds)
    }
}

fn commit<'info>(
    accounts: &SignSuiTx<'info>,
    kind_bytes: Vec<u8>,
    gas_payment: Vec<SuiObjectRef>,
    gas_price: u64,
    gas_budget: u64,
    chain_tag: [u8; 32],
    derivation_seeds: Vec<u8>,
) -> Result<()> {
    require_keys_eq!(accounts.soda_program.key(), soda::ID);
    require!(
        kind_bytes.first() == Some(&sui_bcs::KIND_PROGRAMMABLE),
        SuiDemoError::NotProgrammable
    );
    require!(kind_bytes.len() <= MAX_KIND_LEN, SuiDemoError::KindTooLong);
    require!(
        !gas_payment.is_empty() && gas_payment.len() <= MAX_GAS_COINS,
        SuiDemoError::BadGasPayment
    );

    // 1. The sender is the signer's derived address. It has to be known
    //    before the CPI because Sui signs over it.
    let tweak = compute_tweak(&accounts.user.key().to_bytes(), &derivation_seeds, &chain_tag);
    let foreign_pk_xy = derive_foreign_pk_xy(&accounts.committee.group_pk, &tweak)?;
    let sender = sui_bcs::sui_address_from_pk_xy(&foreign_pk_xy);

    // 2. Envelope, then Sui's two-stage hash.
    let tx_bytes = sui_bcs::encode_transaction_data(
        &kind_bytes,
        &sender,
        &gas_payment,
        &sender,
        gas_price,
        gas_budget,
    );
    let payload = sui_bcs::signing_payload(&tx_bytes);

    msg!("sui sender derived on-chain; committing sha256(blake2b(intent||tx))");

    // 3. CPI soda::request_signature. soda re-derives foreign_pk from the
    //    same signer + seeds + chain_tag and stores it for finalize.
    let cpi_ctx = CpiContext::new(
        accounts.soda_program.to_account_info(),
        soda::cpi::accounts::RequestSignature {
            committee: accounts.committee.to_account_info(),
            sig_request: accounts.sig_request.to_account_info(),
            requester: accounts.user.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
        },
    );
    soda::cpi::request_signature(
        cpi_ctx,
        derivation_seeds,
        payload,
        chain_tag,
        0, // domain_id: secp256k1 ECDSA
    )?;

    // 4. The relayer attaches `0x01 || sig || pk` to exactly these bytes.
    emit!(SuiTxRequested {
        sig_request: accounts.sig_request.key(),
        sender,
        tx_bytes,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SignSuiTx<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    /// soda's committee PDA, read for `group_pk` so the sender can be derived
    /// here. Owner and seeds are checked against the soda program.
    #[account(seeds = [b"committee"], bump = committee.bump, seeds::program = soda::ID)]
    pub committee: Account<'info, Committee>,
    /// CHECK: initialized via the soda CPI as a SigRequest PDA.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: validated against soda::ID inside the handler.
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct SuiTxRequested {
    pub sig_request: Pubkey,
    /// The derived Sui address the transaction is from.
    pub sender: [u8; 32],
    /// BCS `TransactionData`: sign, attach `0x01 || sig || pk`, submit.
    pub tx_bytes: Vec<u8>,
}

#[error_code]
pub enum SuiDemoError {
    #[msg("kind_bytes must be a BCS ProgrammableTransaction (first byte 0x00)")]
    NotProgrammable,
    #[msg("kind_bytes exceeds MAX_KIND_LEN")]
    KindTooLong,
    #[msg("gas_payment must hold between 1 and MAX_GAS_COINS object refs")]
    BadGasPayment,
}
