use anchor_lang::{prelude::*, system_program};

use super::store::StoreInstructionData;
use crate::{error::StorageError, state::BufferAccount};

/// Accounts for `create_buffer`: a fresh buffer keypair (signer), its rent
/// payer, the System Program and the refund destination it records.
#[derive(Accounts)]
#[instruction(data: StoreInstructionData)]
pub struct CreateBuffer<'info> {
    #[account(init, payer = payer, space = BufferAccount::LEN + data.chunk.len())]
    pub buffer: Account<'info, BufferAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: a plain System Program wallet other than the buffer, so it can be
    /// credited when the buffer closes.
    #[account(
        owner = system_program::ID @ StorageError::InvalidRefundDestination,
        constraint = !refund.executable && refund.key() != buffer.key()
            @ StorageError::InvalidRefundDestination,
    )]
    pub refund: UncheckedAccount<'info>,
}

/// Starts an upload with its first chunk: records the owner, payer, refund
/// destination, predecessor and total length, then appends the chunk.
pub(crate) fn process_create_buffer(
    ctx: Context<CreateBuffer>,
    data: StoreInstructionData,
) -> Result<()> {
    let accounts = ctx.accounts;
    accounts.buffer.set_inner(BufferAccount {
        sealed: false,
        owner: data.owner,
        payer: accounts.payer.key(),
        refund: accounts.refund.key(),
        previous: data.previous,
        total_length: data.total_length,
        data_hash: [0; 32],
    });
    let account = accounts.buffer.to_account_info();
    accounts
        .buffer
        .append_chunk(&account, data.offset, &data.chunk)
}
