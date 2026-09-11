//! vault_demo — a Solana **program** owns a foreign address.
//!
//! Every other caller in this repo passes a wallet as the requester, so the
//! address belongs to a person. Here the requester is a PDA, signed for with
//! `invoke_signed`, so the address belongs to the program and moves only
//! when the program's own rules allow it. That is the difference between a
//! wallet for people and a wallet for programs, and it is the thing SODA
//! exists to make possible.
//!
//! Nothing in `soda` is special-cased for this. The tweak is keyed on
//! `requester.key()` either way, so a PDA gets its own derived address by
//! the same formula a wallet does:
//!
//!     tweak       = sha256("SODA-v1" || vault_pda || path || chain_tag)
//!     foreign_pk  = group_pk + tweak·G
//!
//! The policy here is deliberately one rule: a vault records one allowed
//! recipient when it is created and refuses to sign a transaction to anyone
//! else. It is small on purpose, but it is something no wallet can do. A key
//! can always sign anything; this address provably cannot pay anyone but its
//! counterparty, and that guarantee is enforced by Solana rather than
//! promised by whoever holds a key.
//!
//! This is the template to copy. Replace `require_allowed_recipient` with
//! whatever your program should enforce: a DAO vote, a timelock, an oracle
//! condition, a filled order.

use anchor_lang::prelude::*;
use eth_demo::eth_rlp;
use solana_program::keccak;

declare_id!("2Cx2nBHzK38diq52pdLphnbfVzDUFZJBn3GpdjAQ18kE");

/// A plain value transfer. Kept fixed so the recipient rule means what it
/// says: with calldata the "recipient" of a contract call is not the party
/// that ends up with the money, and a whitelist would be theatre.
pub const TRANSFER_GAS_LIMIT: u64 = 21_000;

#[program]
pub mod vault_demo {
    use super::*;

    /// Create a vault. The PDA that is created here is the owner of a
    /// foreign address on every chain, one per `chain_tag`, and no key for
    /// any of them exists.
    pub fn init_vault(
        ctx: Context<InitVault>,
        vault_id: u64,
        allowed_recipient: [u8; 20],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.vault_id = vault_id;
        vault.allowed_recipient = allowed_recipient;

        emit!(VaultCreated {
            vault: vault.key(),
            authority: vault.authority,
            vault_id,
            allowed_recipient,
        });
        Ok(())
    }

    /// Send value from the vault's derived EVM address to the one recipient
    /// the vault is allowed to pay.
    ///
    /// The authority triggers it, but the authority is not the owner of the
    /// address: the PDA is. The authority cannot redirect the payment, and
    /// changing the recipient would mean creating a different vault, which
    /// would have a different derived address holding no funds.
    pub fn vault_sign_eth_transfer(
        ctx: Context<VaultSignEthTransfer>,
        to: [u8; 20],
        value_wei_be: [u8; 16],
        nonce: u64,
        gas_price_wei: u64,
        chain_id: u64,
        chain_tag: [u8; 32],
        derivation_seeds: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.soda_program.key(), soda::ID);

        // The whole point. A wallet-owned address has no equivalent of this
        // line: whoever holds the key decides where the money goes.
        require!(
            to == ctx.accounts.vault.allowed_recipient,
            VaultError::RecipientNotAllowed
        );

        // 1. Build the exact EVM transaction, and hash it the way Ethereum
        //    will. Same encoder eth_demo uses, so the same bytes.
        let unsigned_rlp = eth_rlp::encode_unsigned_legacy(
            nonce,
            gas_price_wei,
            TRANSFER_GAS_LIMIT,
            &to,
            &value_wei_be,
            &[],
            chain_id,
        );
        let payload = keccak::hashv(&[&unsigned_rlp]).to_bytes();

        // 2. CPI soda with the VAULT PDA as the requester. `invoke_signed`
        //    is what makes a PDA a signer, and soda keys the derivation on
        //    whoever signed, so the foreign address is the vault's.
        //
        //    The authority pays the rent. Before soda separated `payer` from
        //    `requester` the vault itself would have had to hold lamports to
        //    ask for a signature at all.
        let authority = ctx.accounts.vault.authority;
        let vault_id_le = ctx.accounts.vault.vault_id.to_le_bytes();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            authority.as_ref(),
            vault_id_le.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        // Bound rather than inlined: `&[vault_seeds]` as an argument is a
        // temporary that dies at the end of the statement, while the CPI
        // context borrows it into the next one.
        let signer_seeds = [vault_seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.soda_program.to_account_info(),
            soda::cpi::accounts::RequestSignature {
                committee: ctx.accounts.committee.to_account_info(),
                sig_request: ctx.accounts.sig_request.to_account_info(),
                requester: ctx.accounts.vault.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &signer_seeds,
        );
        soda::cpi::request_signature(
            cpi_ctx,
            derivation_seeds,
            payload,
            chain_tag,
            0, // domain_id: secp256k1 ECDSA
        )?;

        msg!("vault PDA is the requester; the derived address is the program's");

        emit!(VaultTxRequested {
            sig_request: ctx.accounts.sig_request.key(),
            vault: ctx.accounts.vault.key(),
            chain_id,
            unsigned_rlp,
        });
        Ok(())
    }
}

#[account]
pub struct Vault {
    pub bump: u8,
    /// Who may trigger a payment. Not the owner of the foreign address: the
    /// PDA is, and the authority cannot change where the money goes.
    pub authority: Pubkey,
    pub vault_id: u64,
    /// The only EVM address this vault will ever pay.
    pub allowed_recipient: [u8; 20],
}

impl Vault {
    pub const SIZE: usize = 8 + 1 + 32 + 8 + 20;
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Vault::SIZE,
        seeds = [b"vault", authority.key().as_ref(), &vault_id.to_le_bytes()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultSignEthTransfer<'info> {
    /// Pays rent and is checked against `vault.authority`. It never becomes
    /// the owner of the foreign address.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.authority.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority,
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: passed through to the soda CPI, which checks seeds and bump.
    pub committee: UncheckedAccount<'info>,
    /// CHECK: initialized via the soda CPI as a SigRequest PDA.
    #[account(mut)]
    pub sig_request: UncheckedAccount<'info>,
    /// CHECK: validated against soda::ID inside the handler.
    pub soda_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub vault_id: u64,
    pub allowed_recipient: [u8; 20],
}

#[event]
pub struct VaultTxRequested {
    pub sig_request: Pubkey,
    pub vault: Pubkey,
    pub chain_id: u64,
    pub unsigned_rlp: Vec<u8>,
}

#[error_code]
pub enum VaultError {
    #[msg("this vault may only pay the recipient recorded when it was created")]
    RecipientNotAllowed,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vault's address is a function of the PDA, so two vaults under the
    /// same authority are different owners with different foreign addresses.
    /// This is what makes one program able to hold many independent
    /// positions.
    #[test]
    fn vault_pdas_differ_by_id() {
        let authority = Pubkey::new_unique();
        let (a, _) = Pubkey::find_program_address(
            &[b"vault", authority.as_ref(), &0u64.to_le_bytes()],
            &crate::ID,
        );
        let (b, _) = Pubkey::find_program_address(
            &[b"vault", authority.as_ref(), &1u64.to_le_bytes()],
            &crate::ID,
        );
        assert_ne!(a, b);
    }

    /// A vault's derived key must not equal its authority's, or "the program
    /// owns it" would be indistinguishable from "the wallet owns it".
    #[test]
    fn vault_derives_a_different_address_than_its_authority() {
        use soda::derive_onchain::compute_tweak;
        let authority = Pubkey::new_unique();
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", authority.as_ref(), &7u64.to_le_bytes()],
            &crate::ID,
        );
        let mut tag = [0u8; 32];
        tag[..12].copy_from_slice(b"base-sepolia");
        assert_ne!(
            compute_tweak(&vault.to_bytes(), &[], &tag),
            compute_tweak(&authority.to_bytes(), &[], &tag),
        );
    }

    fn transfer_rlp(to: &[u8; 20], value: u128) -> Vec<u8> {
        eth_rlp::encode_unsigned_legacy(
            3,
            2_000_000_000,
            TRANSFER_GAS_LIMIT,
            to,
            &value.to_be_bytes(),
            &[],
            84_532,
        )
    }

    /// The recipient rule is only worth anything if the recipient is inside
    /// the bytes the committee signs. If two recipients produced the same
    /// payload, a signature obtained for the allowed one would spend to the
    /// other.
    #[test]
    fn the_recipient_is_bound_into_the_signed_payload() {
        let allowed = transfer_rlp(&[0xaa; 20], 1_000_000_000_000_000);
        let other = transfer_rlp(&[0xbb; 20], 1_000_000_000_000_000);
        assert_ne!(allowed, other);
        assert_ne!(
            keccak::hashv(&[&allowed]).to_bytes(),
            keccak::hashv(&[&other]).to_bytes(),
        );
    }

    /// A plain send: the r and s placeholders are empty and there is no
    /// calldata, so `to` really is the party that receives the value.
    #[test]
    fn transfer_rlp_is_a_plain_send_with_no_calldata() {
        let rlp = transfer_rlp(&[0xaa; 20], 1_000_000_000_000_000);
        // Trailing 0x80 0x80 are the empty r and s of the EIP-155 sighash.
        assert_eq!(&rlp[rlp.len() - 2..], &[0x80, 0x80]);
        // Empty calldata is a single 0x80, and it sits before the chain id.
        let with_data = eth_rlp::encode_unsigned_legacy(
            3,
            2_000_000_000,
            TRANSFER_GAS_LIMIT,
            &[0xaa; 20],
            &1_000_000_000_000_000u128.to_be_bytes(),
            &[0x01],
            84_532,
        );
        assert_eq!(with_data.len(), rlp.len());
        assert_ne!(with_data, rlp);
    }
}
