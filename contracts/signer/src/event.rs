// Decoder for soda's `SigRequested` anchor event.
//
// Anchor emits events as `Program data: <base64>` log lines, where the
// decoded bytes are: [8-byte event discriminator][borsh-encoded event].
// The discriminator is `sha256("event:" + EventName)[..8]`.

use base64::engine::Engine;
use borsh::BorshDeserialize;
use sha2::{Digest, Sha256};

#[derive(BorshDeserialize, Debug)]
pub struct SigRequestedEvent {
    pub sig_request: [u8; 32],
    pub requester: [u8; 32],
    pub foreign_pk_xy: [u8; 64],
    pub payload: [u8; 32],
    pub chain_tag: [u8; 32],
    pub derivation_seeds: Vec<u8>,
}

pub fn anchor_event_disc(name: &str) -> [u8; 8] {
    let r = Sha256::digest(format!("event:{name}").as_bytes());
    let mut d = [0u8; 8];
    d.copy_from_slice(&r[..8]);
    d
}

const PROGRAM_DATA_PREFIX: &str = "Program data: ";

pub fn try_parse_sig_requested(line: &str) -> Option<SigRequestedEvent> {
    let b64 = line.strip_prefix(PROGRAM_DATA_PREFIX)?;
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() < 8 {
        return None;
    }
    let disc = anchor_event_disc("SigRequested");
    if raw[..8] != disc {
        return None;
    }
    SigRequestedEvent::try_from_slice(&raw[8..]).ok()
}
