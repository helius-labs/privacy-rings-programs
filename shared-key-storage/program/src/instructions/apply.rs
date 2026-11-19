use anchor_lang::prelude::*;

use crate::{
    error::StorageError,
    state::{BufferAccount, PointerAccount, POINTER_SEED},
};

/// Instruction data of `apply`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ApplyInstructionData {
    pub expected_previous: Pubkey,
    pub expected_revision: u64,
    pub approved_hash: [u8; 32],
}

/// Accounts for `apply`. The first publication has no predecessor: it passes
/// this program's id in the `previous` and `refund` slots (Anchor's `None`).
#[derive(Accounts)]
#[instruction(data: ApplyInstructionData)]
pub struct Apply<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = PointerAccount::LEN,
        seeds = [POINTER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub pointer: Account<'info, PointerAccount>,
    #[account(
        mut,
        has_one = owner,
        constraint = !buffer.sealed @ StorageError::Sealed,
        constraint = buffer.to_account_info().data_len()
            == BufferAccount::LEN + buffer.total_length as usize
            @ StorageError::InvalidLength,
        constraint = buffer.data_hash == data.approved_hash @ StorageError::HashMismatch,
        // A pointer that must refund itself could never be replaced again.
        constraint = buffer.refund != pointer.key() @ StorageError::RefundIsPointer,
    )]
    pub buffer: Account<'info, BufferAccount>,
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// The published record being replaced; closed by this instruction.
    #[account(
        mut,
        address = data.expected_previous @ StorageError::PredecessorMismatch,
        constraint = previous.sealed && previous.owner == owner.key()
            @ StorageError::InvalidPredecessor,
        has_one = refund @ StorageError::RefundMismatch,
    )]
    pub previous: Option<Account<'info, BufferAccount>>,
    /// CHECK: the predecessor's recorded refund destination (`has_one`).
    pub refund: Option<UncheckedAccount<'info>>,
}

/// Publishes a complete upload as the owner's current record and closes the
/// record it replaces, refunding that record's rent. All of it is one atomic
/// instruction.
pub(crate) fn process_apply(ctx: Context<Apply>, data: ApplyInstructionData) -> Result<()> {
    let accounts = ctx.accounts;
    // Revisions prevent stale approvals succeeding after a closed address is reused.
    require!(
        accounts.buffer.previous == data.expected_previous
            && accounts.pointer.current == data.expected_previous
            && accounts.pointer.revision == data.expected_revision,
        StorageError::StaleHead
    );
    let next_revision = accounts
        .pointer
        .revision
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    // A freshly created pointer has revision 0: there is nothing to close.
    if accounts.pointer.revision == 0 {
        require!(
            accounts.previous.is_none() && accounts.refund.is_none(),
            StorageError::InvalidFirstPublication
        );
    } else {
        let previous = accounts
            .previous
            .as_ref()
            .ok_or(StorageError::PredecessorMismatch)?;
        let refund = accounts
            .refund
            .as_ref()
            .ok_or(StorageError::RefundMismatch)?;
        // A destination that has become a program cannot be credited; the apply
        // payer receives that refund so the record stays replaceable.
        let recipient = if refund.executable {
            accounts.payer.to_account_info()
        } else {
            require!(refund.is_writable, StorageError::NotWritable);
            refund.to_account_info()
        };
        previous.close(recipient)?;
    }
    accounts.buffer.sealed = true;
    accounts.pointer.current = accounts.buffer.key();
    accounts.pointer.revision = next_revision;
    Ok(())
}
