// Daemon configuration — env-var driven, with defaults that line up with
// .env at the repo root. The daemon walks up looking for .env so it works
// no matter where you run it from.

use anyhow::{Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::{env, fs, path::PathBuf, str::FromStr};

const DEFAULT_SODA_PROGRAM_ID: &str = "99apYWpnoMWwA2iXyJZcTMoTEag6tdFasjujdhdeG8b4";
const DEFAULT_ETH_DEMO_PROGRAM_ID: &str = "9g9eAkNbjpkVLi692vhgcUapJKS26yQTgsLzKbXKJXWM";

pub struct Config {
    pub rpc_url: String,
    pub ws_url: String,
    pub soda_program_id: Pubkey,
    /// Programs we expect to see as the originator of derivation. The signer
    /// iterates this list, computes the candidate `foreign_pk` for each, and
    /// signs only when one matches the event's `foreign_pk_xy`. Add more
    /// program IDs (comma-separated in `SODA_KNOWN_REQUESTERS`) when SODA
    /// gets more callers.
    pub known_requesters: Vec<Pubkey>,
    pub signer_keystore_path: PathBuf,
    pub payer_path: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        load_dotenv();

        let rpc_url = env::var("SOLANA_RPC_URL")
            .or_else(|_| env::var("SOLANA_DEVNET_RPC_URL"))
            .context("set SOLANA_RPC_URL or SOLANA_DEVNET_RPC_URL")?;
        let ws_url = env::var("SOLANA_WS_URL").unwrap_or_else(|_| ws_from_http(&rpc_url));

        let soda_program_id = Pubkey::from_str(
            &env::var("SODA_PROGRAM_ID").unwrap_or_else(|_| DEFAULT_SODA_PROGRAM_ID.to_string()),
        )?;

        let known_str = env::var("SODA_KNOWN_REQUESTERS")
            .unwrap_or_else(|_| DEFAULT_ETH_DEMO_PROGRAM_ID.to_string());
        let known_requesters: Result<Vec<_>> = known_str
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| Pubkey::from_str(s.trim()).context("bad pubkey in SODA_KNOWN_REQUESTERS"))
            .collect();
        let known_requesters = known_requesters?;

        let signer_keystore_path = match env::var("SODA_SIGNER_KEY_PATH") {
            Ok(p) => PathBuf::from(p),
            Err(_) => find_repo_file("keyshare.dev.json")
                .unwrap_or_else(|| PathBuf::from("keyshare.dev.json")),
        };

        let payer_path = match env::var("ANCHOR_WALLET") {
            Ok(p) => PathBuf::from(p),
            Err(_) => {
                let home = env::var("HOME").unwrap_or_else(|_| "/root".to_string());
                PathBuf::from(format!("{home}/.config/solana/id.json"))
            }
        };

        Ok(Self {
            rpc_url,
            ws_url,
            soda_program_id,
            known_requesters,
            signer_keystore_path,
            payer_path,
        })
    }
}

fn ws_from_http(http: &str) -> String {
    if let Some(rest) = http.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    if let Some(rest) = http.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    http.to_string()
}

fn find_repo_file(name: &str) -> Option<PathBuf> {
    let mut cur = env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = cur.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

fn load_dotenv() {
    let Some(path) = find_repo_file(".env") else {
        return;
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let k = line[..eq].trim();
        let v = line[eq + 1..].trim();
        if env::var(k).is_err() {
            // SAFETY: single-threaded at startup
            unsafe { env::set_var(k, v) };
        }
    }
}
