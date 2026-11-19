// Anchor checks that a custom discriminator is non-empty; with a literal
// discriminator clippy sees that generated check as always false.
#![allow(clippy::const_is_empty)]

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::StorageError;

/// Every chunk but the last is exactly this long, so the chained hash depends
/// only on the bytes, and one `store` fits a 1,232-byte transaction with two
/// signers and compute budget instructions.
pub const CHUNK_LEN: usize = 768;
/// A buffer account, header included, is at most 10 MiB.
pub const MAX_RECORD_LEN: usize = 10 * 1024 * 1024 - BufferAccount::LEN;

/// An upload: this header, then the uploaded bytes. The layout matches the
/// deployed program byte for byte (173-byte header), so buffers it wrote stay
/// loadable.
#[account(discriminator = b"STORBUF1")]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct BufferAccount {
    /// Set by `apply` once the upload is published; it is then immutable.
    pub sealed: bool,
    pub owner: Pubkey,
    /// Paid the buffer's rent and signs every chunk and `close`.
    pub payer: Pubkey,
    /// Receives the rent when the buffer is cancelled or superseded.
    pub refund: Pubkey,
    /// The record this upload replaces; an update precondition, not history.
    pub previous: Pubkey,
    pub total_length: u32,
    /// `SHA256(data_hash || chunk)` over the chunks written so far, from zero.
    pub data_hash: [u8; 32],
}

impl BufferAccount {
    /// Discriminator plus header; the uploaded bytes start here.
    pub const LEN: usize = Self::DISCRIMINATOR.len() + Self::INIT_SPACE;

    /// Appends `chunk` to the upload and chains it into `data_hash`.
    ///
    /// `account` is this buffer's account, already sized to end with the
    /// chunk, so the chunk lands right after the bytes written so far and
    /// `offset` must equal that count. A chunk is 1..=CHUNK_LEN bytes of a
    /// record of 1..=MAX_RECORD_LEN bytes, and only the final chunk may be
    /// short, so the bytes alone fix the hash.
    pub(crate) fn append_chunk(
        &mut self,
        account: &AccountInfo,
        offset: u32,
        chunk: &[u8],
    ) -> Result<()> {
        let written = offset as usize;
        let end = written
            .checked_add(chunk.len())
            .ok_or(StorageError::InvalidLength)?;
        require!(
            account.data_len() == Self::LEN + end,
            StorageError::InvalidOffset
        );
        let total_length = self.total_length as usize;
        require!(
            (1..=CHUNK_LEN).contains(&chunk.len())
                && (1..=MAX_RECORD_LEN).contains(&total_length)
                && end <= total_length
                && (chunk.len() == CHUNK_LEN || end == total_length),
            StorageError::InvalidLength
        );
        self.data_hash = hashv(&[&self.data_hash, chunk]).to_bytes();
        let mut data = account.try_borrow_mut_data()?;
        data.get_mut(Self::LEN + written..)
            .ok_or(StorageError::InvalidLength)?
            .copy_from_slice(chunk);
        Ok(())
    }
}

// Deployed buffers have a 173-byte header; the layout must never change it.
const _: () = assert!(BufferAccount::LEN == 173);
