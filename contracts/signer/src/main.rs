// SODA signer daemon.
//
// Subscribes to Solana logs filtered by the SODA program ID. For each
// `SigRequested` event:
//   1. Iterate known requester programs (e.g. eth_demo).
//   2. For each, compute candidate `foreign_pk = group_pk + tweak·G`.
//   3. When one matches `event.foreign_pk_xy`, sign the payload with
//      `(group_sk + tweak) mod n` via `k256::ecdsa::SigningKey::sign_prehash`.
//   4. Build a `soda::finalize_signature` ix manually + submit it.
//
// Idempotent: races with `apps/demo` and `apps/relayer` (which also submit
// `finalize_signature`); whichever lands first wins, the loser sees
// `AlreadyCompleted` and treats it as success.

mod config;
mod derive;
mod event;
mod ix;

use anyhow::{anyhow, Context, Result};
use config::Config;
use derive::{compute_tweak, derive_foreign_pk_xy};
use event::{try_parse_sig_requested, SigRequestedEvent};
use futures_util::StreamExt;
use ix::finalize_signature_ix;
use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, Scalar};
use solana_client::{
    nonblocking::{pubsub_client::PubsubClient, rpc_client::RpcClient},
    rpc_config::{RpcTransactionLogsConfig, RpcTransactionLogsFilter},
};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer as _},
    transaction::Transaction,
};
use std::fs;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = Config::from_env().context("loading config")?;

    let payer = read_keypair_file(&cfg.payer_path)
        .map_err(|e| anyhow!("read payer keypair {}: {}", cfg.payer_path.display(), e))?;

    let signer_sk_hex = fs::read_to_string(&cfg.signer_keystore_path)
        .with_context(|| format!("reading signer key from {}", cfg.signer_keystore_path.display()))?;
    let signer_sk_bytes: [u8; 32] = hex::decode(signer_sk_hex.trim())
        .context("decoding signer key hex")?
        .try_into()
        .map_err(|_| anyhow!("signer key not 32 bytes"))?;
    let signing_key = SigningKey::from_bytes(&signer_sk_bytes.into())
        .context("invalid k256 signing key")?;

    let group_pk_compressed_vec: Vec<u8> = signing_key
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    let group_pk_compressed: [u8; 33] = group_pk_compressed_vec
        .try_into()
        .map_err(|_| anyhow!("compressed pk not 33 bytes"))?;

    let committee_pda = Pubkey::find_program_address(&[b"committee"], &cfg.soda_program_id).0;

    println!("\x1b[36m┏━ SODA signer daemon ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\x1b[0m");
    println!("\x1b[36m┃\x1b[0m payer:        {}", payer.pubkey());
    println!("\x1b[36m┃\x1b[0m group pk:     0x{}", hex::encode(group_pk_compressed));
    println!("\x1b[36m┃\x1b[0m soda program: {}", cfg.soda_program_id);
    println!("\x1b[36m┃\x1b[0m committee:    {}", committee_pda);
    println!("\x1b[36m┃\x1b[0m rpc:          {}", strip_query(&cfg.rpc_url));
    println!("\x1b[36m┃\x1b[0m ws:           {}", strip_query(&cfg.ws_url));
    println!("\x1b[36m┃\x1b[0m known callers ({}):", cfg.known_requesters.len());
    for p in &cfg.known_requesters {
        println!("\x1b[36m┃\x1b[0m   - {}", p);
    }
    println!("\x1b[36m┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\x1b[0m");

    let rpc = RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed());
    let pubsub = PubsubClient::new(&cfg.ws_url)
        .await
        .with_context(|| format!("connecting WS at {}", cfg.ws_url))?;

    let (mut log_sub, _unsub) = pubsub
        .logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![cfg.soda_program_id.to_string()]),
            RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::confirmed()),
            },
        )
        .await
        .context("logs_subscribe failed")?;

    println!("watching for SigRequested events… (Ctrl-C to stop)");

    while let Some(msg) = log_sub.next().await {
        let logs = msg.value;
        if logs.err.is_some() {
            continue;
        }
        for line in &logs.logs {
            let Some(event) = try_parse_sig_requested(line) else {
                continue;
            };
            if let Err(e) = handle_event(
                &rpc,
                &cfg,
                &payer,
                &signing_key,
                &group_pk_compressed,
                &committee_pda,
                &event,
            )
            .await
            {
                eprintln!("  \x1b[31m✗\x1b[0m {e:#}");
            }
        }
    }

    Ok(())
}

async fn handle_event(
    rpc: &RpcClient,
    cfg: &Config,
    payer: &Keypair,
    signing_key: &SigningKey,
    group_pk_compressed: &[u8; 33],
    committee_pda: &Pubkey,
    event: &SigRequestedEvent,
) -> Result<()> {
    let sig_req = Pubkey::from(event.sig_request);
    println!(
        "→ \x1b[33mSigRequested\x1b[0m sig_request={} payload=0x{}…",
        sig_req,
        hex::encode(&event.payload[..16])
    );

    // Find which known requester program produced this derivation.
    let mut tweak: Option<[u8; 32]> = None;
    let mut matched_program: Option<Pubkey> = None;
    for caller in &cfg.known_requesters {
        let candidate_tweak =
            compute_tweak(&caller.to_bytes(), &event.derivation_seeds, &event.chain_tag);
        let candidate_xy = derive_foreign_pk_xy(group_pk_compressed, &candidate_tweak)?;
        if candidate_xy == event.foreign_pk_xy {
            tweak = Some(candidate_tweak);
            matched_program = Some(*caller);
            break;
        }
    }

    let tweak = match tweak {
        Some(t) => t,
        None => {
            println!(
                "  \x1b[33m⚠\x1b[0m no known caller matches event.foreign_pk_xy — skipping. \
                 Add the requester program to SODA_KNOWN_REQUESTERS env."
            );
            return Ok(());
        }
    };

    if let Some(p) = matched_program {
        println!("  matched caller: {}", p);
    }

    // tweaked_sk = sk + tweak (mod n). Any signature from this key recovers
    // to group_pk + tweak·G = foreign_pk_xy.
    let sk_bytes: FieldBytes = signing_key.to_bytes();
    let sk_scalar_opt: Option<Scalar> = Scalar::from_repr(sk_bytes).into();
    let sk_scalar = sk_scalar_opt.ok_or_else(|| anyhow!("group sk invalid scalar"))?;
    let tweak_fb: FieldBytes = tweak.into();
    let tweak_scalar_opt: Option<Scalar> = Scalar::from_repr(tweak_fb).into();
    let tweak_scalar = tweak_scalar_opt.ok_or_else(|| anyhow!("tweak invalid scalar"))?;
    let tweaked_scalar = sk_scalar + tweak_scalar;
    let tweaked_sk_bytes: FieldBytes = tweaked_scalar.to_bytes();
    let tweaked_signing_key = SigningKey::from_bytes(&tweaked_sk_bytes)
        .map_err(|e| anyhow!("tweaked sk invalid: {e}"))?;

    let (signature, recovery_id): (Signature, RecoveryId) = tweaked_signing_key
        .sign_prehash_recoverable(&event.payload)
        .map_err(|e| anyhow!("sign_prehash_recoverable failed: {e}"))?;
    let sig_bytes: [u8; 64] = signature.to_bytes().into();
    let recovery_byte: u8 = recovery_id.to_byte();

    println!("  ✓ signed (recovery_id={})", recovery_byte);

    let inst = finalize_signature_ix(
        &cfg.soda_program_id,
        committee_pda,
        &sig_req,
        &payer.pubkey(),
        sig_bytes,
        recovery_byte,
    )?;

    let recent_blockhash = rpc.get_latest_blockhash().await?;
    let tx = Transaction::new_signed_with_payer(
        &[inst],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );

    match rpc.send_and_confirm_transaction(&tx).await {
        Ok(sig) => {
            println!("  \x1b[32m✓\x1b[0m finalize_signature submitted: {}", sig);
        }
        Err(e) => {
            let msg = format!("{e}");
            // soda::SodaError::AlreadyCompleted is the first error in the enum
            // → custom program error 0x1770 (= 6000).
            if msg.contains("AlreadyCompleted")
                || msg.contains("0x1770")
                || msg.contains("custom program error")
            {
                println!(
                    "  \x1b[2m·\x1b[0m already finalized by another submitter (demo / relayer) — fine"
                );
            } else {
                return Err(anyhow!("finalize tx failed: {msg}"));
            }
        }
    }

    Ok(())
}

fn strip_query(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}
