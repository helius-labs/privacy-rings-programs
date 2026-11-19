// Anchor checks that a custom discriminator is non-empty; with a literal
// discriminator clippy sees that generated check as always false.
#![allow(clippy::const_is_empty)]

use anchor_lang::prelude::*;

/// Seed of the owner's pointer PDA, `[POINTER_SEED, owner]`. Deployed pointers
/// live at this address, so the value must never change.
pub const POINTER_SEED: &[u8] = b"head";

/// The owner's published record, at the `[POINTER_SEED, owner]` PDA. Created by
/// the first `apply`, closed only by `close_pointer`. The layout and
/// discriminator match the deployed program's head account, so existing
/// pointers stay loadable.
#[account(discriminator = b"STORHEAD")]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct PointerAccount {
    pub current: Pubkey,
    /// Increments on every publication, starting at 1, so an approval signed
    /// against an older pointer fails even if a closed record address is reused.
    pub revision: u64,
}

impl PointerAccount {
    pub const LEN: usize = Self::DISCRIMINATOR.len() + Self::INIT_SPACE;
}

// Deployed pointers are 48 bytes; the layout must never change that.
const _: () = assert!(PointerAccount::LEN == 48);
