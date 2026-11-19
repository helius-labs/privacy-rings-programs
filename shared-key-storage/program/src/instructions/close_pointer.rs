use anchor_lang::prelude::*;

use crate::{
    error::StorageError,
    state::{BufferAccount, PointerAccount, POINTER_SEED},
};

/// Accounts for `close_pointer`: the owner's pointer, the record it points to,
/// the owner (signer), the recipient of the pointer's rent and the record's
/// recorded refund destination.
#[derive(Accounts)]
pub struct ClosePointer<'info> {
    #[account(
        mut,
        seeds = [POINTER_SEED, owner.key().as_ref()],
        bump,
        close = recipient,
    )]
    pub pointer: Account<'info, PointerAccount>,
    #[account(
        mut,
        address = pointer.current @ StorageError::PredecessorMismatch,
        constraint = record.sealed && record.owner == owner.key()
            @ StorageError::InvalidPredecessor,
        has_one = refund @ StorageError::RefundMismatch,
    )]
    pub record: Account<'info, BufferAccount>,
    pub owner: Signer<'info>,
    /// CHECK: any writable account the owner chooses for the pointer's rent.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: the record's recorded refund destination (`has_one`).
    pub refund: UncheckedAccount<'info>,
}

/// Retires the owner's storage: closes the current record into its refund
/// destination and the pointer into `recipient`.
///
/// The pointer's revision restarts at zero if the owner publishes again, so an
/// unexecuted approval for a first publication becomes valid again.
pub(crate) fn process_close_pointer(ctx: Context<ClosePointer>) -> Result<()> {
    let accounts = ctx.accounts;
    // A destination that has become a program cannot be credited; its refund
    // goes to the pointer's recipient instead, as `apply` sends it to the payer.
    let destination = if accounts.refund.executable {
        accounts.recipient.to_account_info()
    } else {
        require!(accounts.refund.is_writable, StorageError::NotWritable);
        accounts.refund.to_account_info()
    };
    accounts.record.close(destination)
}
