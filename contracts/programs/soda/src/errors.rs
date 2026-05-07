use anchor_lang::prelude::*;

#[error_code]
pub enum SodaError {
    #[msg("Signature request already completed")]
    AlreadyCompleted,
    #[msg("Recovered pubkey does not match derived foreign pk")]
    PubkeyMismatch,
    #[msg("Signature request expired")]
    Expired,
    #[msg("Invalid recovery id (must be 0 or 1)")]
    InvalidRecoveryId,
    #[msg("Derivation seeds exceed maximum length")]
    SeedsTooLong,
    #[msg("Group public key is not a valid secp256k1 point")]
    InvalidGroupPk,
    #[msg("Tweak is not a valid secp256k1 scalar")]
    InvalidTweak,
    #[msg("Derivation produced an invalid SEC1 encoding")]
    DerivationFailed,
    #[msg("secp256k1_recover failed")]
    RecoverFailed,
}
