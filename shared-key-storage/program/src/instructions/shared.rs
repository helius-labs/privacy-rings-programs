//! Account checks, buffer loading and System Program calls shared by the
//! instructions. The errors are part of the deployed interface: keep them as
//! they are.

use pinocchio::{
    cpi::Signer,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, Transfer};

use crate::state::BufferHeader;

/// Reads a buffer's header. The account must be a non-executable account of
/// this program. Returns a copy, so no borrow is held across CPIs or resizes.
pub fn load_buffer(account: &AccountView) -> Result<BufferHeader, ProgramError> {
    if !account.owned_by(&crate::ID) || account.executable() {
        return Err(ProgramError::IllegalOwner);
    }
    BufferHeader::read_from(&account.try_borrow()?)
}

pub fn require_signers(accounts: [&AccountView; 2]) -> ProgramResult {
    if accounts.iter().any(|account| !account.is_signer()) {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

pub fn require_writable(account: &AccountView) -> ProgramResult {
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn require_distinct(first: &AccountView, second: &AccountView) -> ProgramResult {
    if first.address() == second.address() {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

/// An account the program can create: owned by the System Program, no data,
/// not executable. It may already hold lamports.
pub fn require_empty_system_account(account: &AccountView) -> ProgramResult {
    if !account.owned_by(&pinocchio_system::ID) || account.data_len() != 0 || account.executable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// A rent payer: a writable plain wallet, next to the System Program it pays through.
pub fn require_payer(payer: &AccountView, system_program: &AccountView) -> ProgramResult {
    require_writable(payer)?;
    require_empty_system_account(payer)?;
    if !pinocchio_system::check_id(system_program.address()) {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// The refund destination is fixed at the first `store`. It must be a
/// non-executable System Program account other than the buffer, so it can be
/// credited when the buffer closes.
pub fn require_refund_destination(refund: &AccountView, buffer: &AccountView) -> ProgramResult {
    require_distinct(refund, buffer)?;
    if !refund.owned_by(&pinocchio_system::ID) || refund.executable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Transfers whatever `account` lacks to be rent exempt at `size` bytes.
pub fn top_up_rent(payer: &AccountView, account: &AccountView, size: usize) -> ProgramResult {
    let required = Rent::get()?.try_minimum_balance(size)?;
    let top_up = required.saturating_sub(account.lamports());
    if top_up == 0 {
        return Ok(());
    }
    Transfer {
        from: payer,
        to: account,
        lamports: top_up,
    }
    .invoke()
}

/// Gives a System Program account `size` bytes of data and hands it to this
/// program. Allocate and Assign instead of CreateAccount accept an address
/// someone has prefunded.
pub fn allocate_and_assign(
    account: &AccountView,
    size: usize,
    signers: &[Signer],
) -> ProgramResult {
    Allocate {
        account,
        space: size as u64,
    }
    .invoke_signed(signers)?;
    Assign {
        account,
        owner: &crate::ID,
    }
    .invoke_signed(signers)
}

/// Moves every lamport to `recipient`, then hands the account back to the
/// System Program with no data, so later instructions in the same transaction
/// cannot load it either.
pub fn close_account(account: &mut AccountView, recipient: &mut AccountView) -> ProgramResult {
    let balance = recipient
        .lamports()
        .checked_add(account.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    recipient.set_lamports(balance);
    account.set_lamports(0);
    account.close()
}
