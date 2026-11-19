use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use super::shared::{close_account, load_buffer, require_distinct, require_writable};
use crate::error::{fail, StorageError};

/// Accounts for `close`, in order; trailing accounts are ignored.
pub struct CloseAccounts<'a> {
    /// Writable unpublished buffer.
    pub buffer: &'a mut AccountView,
    /// Signer that paid the buffer's rent.
    pub payer: &'a AccountView,
    /// Writable refund destination the buffer recorded.
    pub refund: &'a mut AccountView,
}

impl<'a> CloseAccounts<'a> {
    pub fn parse(accounts: &'a mut [AccountView]) -> Result<Self, ProgramError> {
        let [buffer, payer, refund, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        if !payer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        require_writable(buffer)?;
        require_writable(refund)?;
        require_distinct(buffer, refund)?;
        Ok(Self {
            buffer,
            payer,
            refund,
        })
    }
}

/// Cancels an unpublished upload: its rent payer signs and the rent goes to
/// its refund destination. The buffer keypair is not needed.
///
/// Steps:
/// 1. Parse and check the accounts.
/// 2. Require an unsealed buffer whose recorded payer signed and whose
///    recorded destination is the refund account.
/// 3. Close the buffer into the destination.
pub fn process_close(accounts: &mut [AccountView]) -> ProgramResult {
    // 1. Signature and writability.
    let accounts = CloseAccounts::parse(accounts)?;
    // 2. Only an upload in progress, by its own payer.
    let header = load_buffer(accounts.buffer)?;
    if header.is_sealed() {
        return Err(fail(StorageError::Sealed));
    }
    if &header.payer != accounts.payer.address() {
        return Err(fail(StorageError::PayerMismatch));
    }
    if &header.refund != accounts.refund.address() {
        return Err(fail(StorageError::RefundMismatch));
    }
    // 3. Refund the destination.
    close_account(accounts.buffer, accounts.refund)
}
