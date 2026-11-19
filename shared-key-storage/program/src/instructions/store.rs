use anchor_lang::prelude::*;

use crate::{error::StorageError, state::BufferAccount};

/// Instruction data of `create_buffer` (first chunk, `offset` 0) and `store`
/// (later chunks).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct StoreInstructionData {
    pub owner: Pubkey,
    pub previous: Pubkey,
    pub total_length: u32,
    pub offset: u32,
    pub chunk: Vec<u8>,
}

/// Accounts for `store`: the unpublished buffer (signer), its recorded payer,
/// the System Program and its recorded refund destination.
///
/// `realloc` runs before the other constraints and grows the buffer by the
/// chunk; every later failure rolls the growth back with the transaction.
#[derive(Accounts)]
#[instruction(data: StoreInstructionData)]
pub struct Store<'info> {
    #[account(
        mut,
        signer,
        realloc = buffer.to_account_info().data_len() + data.chunk.len(),
        realloc::payer = payer,
        realloc::zero = false,
        constraint = !buffer.sealed @ StorageError::Sealed,
        has_one = payer @ StorageError::PayerMismatch,
        has_one = refund @ StorageError::MetadataMismatch,
        constraint = buffer.owner == data.owner
            && buffer.previous == data.previous
            && buffer.total_length == data.total_length
            @ StorageError::MetadataMismatch,
    )]
    pub buffer: Account<'info, BufferAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: must be the buffer's recorded refund destination (`has_one`).
    pub refund: UncheckedAccount<'info>,
}

/// Appends a later chunk at the buffer's current end.
pub(crate) fn process_store(ctx: Context<Store>, data: StoreInstructionData) -> Result<()> {
    let buffer = &mut ctx.accounts.buffer;
    let account = buffer.to_account_info();
    buffer.append_chunk(&account, data.offset, &data.chunk)
}
