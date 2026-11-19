use anchor_lang::prelude::*;

use crate::{error::StorageError, state::BufferAccount};

/// Accounts for `close_buffer`: an unpublished buffer, its recorded rent payer
/// (signer) and its recorded refund destination, which receives the rent. The
/// buffer keypair is not needed.
#[derive(Accounts)]
pub struct CloseBuffer<'info> {
    #[account(
        mut,
        constraint = !buffer.sealed @ StorageError::Sealed,
        has_one = payer @ StorageError::PayerMismatch,
        has_one = refund @ StorageError::RefundMismatch,
        close = refund,
    )]
    pub buffer: Account<'info, BufferAccount>,
    pub payer: Signer<'info>,
    /// CHECK: must be the buffer's recorded refund destination (`has_one`).
    #[account(mut)]
    pub refund: UncheckedAccount<'info>,
}

/// Cancels an unpublished upload; the `close` constraint refunds its rent.
pub(crate) fn process_close_buffer(_ctx: Context<CloseBuffer>) -> Result<()> {
    Ok(())
}
