use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

use super::shared::{
    allocate_and_assign, close_account, load_buffer, require_distinct,
    require_empty_system_account, require_payer, require_signers, require_writable, top_up_rent,
};
use crate::{
    error::{fail, StorageError},
    instruction::ApplyData,
    state::{BufferHeader, Head, HEAD_PDA_SEED, NO_RECORD},
};

/// Accounts for `apply`, in order; trailing accounts are ignored.
pub struct ApplyAccounts<'a> {
    /// Writable `[HEAD_PDA_SEED, owner]` PDA, created on the first publication.
    pub head: &'a mut AccountView,
    /// Writable, complete, unsealed upload to publish.
    pub buffer: &'a mut AccountView,
    /// Signer whose head this is.
    pub owner: &'a AccountView,
    /// Writable signer; funds the head on the first publication.
    pub payer: &'a mut AccountView,
    /// The published record to close, or the System Program on the first publication.
    pub previous: &'a mut AccountView,
    /// The predecessor's refund destination, or the System Program on the first publication.
    pub refund: &'a mut AccountView,
}

impl<'a> ApplyAccounts<'a> {
    pub fn parse(accounts: &'a mut [AccountView]) -> Result<Self, ProgramError> {
        let [head, buffer, owner, payer, system_program, previous, refund, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        require_signers([&*owner, &*payer])?;
        require_writable(head)?;
        require_writable(buffer)?;
        require_payer(payer, system_program)?;
        require_distinct(head, buffer)?;
        require_distinct(head, payer)?;
        require_distinct(buffer, payer)?;
        Ok(Self {
            head,
            buffer,
            owner,
            payer,
            previous,
            refund,
        })
    }
}

/// Publishes a complete upload as the owner's current record and closes the
/// record it replaces, refunding that record's rent. All of it is one atomic
/// instruction.
///
/// Steps:
/// 1. Parse and check the accounts.
/// 2. Require the head to be the owner's canonical PDA.
/// 3. Require a complete, unsealed upload of the owner's with the approved hash.
/// 4. Load the current head, or an empty one before the first publication.
/// 5. Require the approval's predecessor and revision to match the head.
/// 6. Check the predecessor and choose who receives its rent.
/// 7. Create the head on the first publication.
/// 8. Seal the upload, advance the head and close the predecessor.
pub fn process_apply(accounts: &mut [AccountView], data: ApplyData) -> ProgramResult {
    // 1. Signatures, writability, payer and System Program.
    let accounts = ApplyAccounts::parse(accounts)?;
    // 2. The head PDA.
    let bump = verify_head_pda(accounts.head, accounts.owner.address())?;
    // 3. The upload.
    let mut header = load_replacement(&accounts, &data)?;
    // 4. The current head.
    let initialized = accounts.head.owned_by(&crate::ID);
    let current = if initialized {
        Head::read_from(&accounts.head.try_borrow()?)?
    } else {
        require_empty_system_account(accounts.head)?;
        Head::new(NO_RECORD, 0)
    };
    // 5. Revisions prevent stale approvals succeeding after a closed address is reused.
    if header.previous != data.expected_previous
        || current.current != data.expected_previous
        || current.revision() != data.expected_revision
    {
        return Err(fail(StorageError::StaleHead));
    }
    if accounts.previous.address() != &data.expected_previous {
        return Err(ProgramError::InvalidArgument);
    }
    // 6. The predecessor and its refund recipient.
    let refund_to_payer = if initialized {
        check_predecessor(&accounts)?
    } else if !pinocchio_system::check_id(accounts.refund.address()) {
        // The first publication closes nothing; both slots hold the System Program.
        return Err(ProgramError::InvalidArgument);
    } else {
        false
    };
    let next_revision = current
        .revision()
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    // 7. The first publication creates the head.
    if !initialized {
        create_head(&accounts, bump)?;
    }
    // 8. Publish and close.
    header.seal();
    header.write_to(&mut accounts.buffer.try_borrow_mut()?)?;
    Head::new(*accounts.buffer.address(), next_revision)
        .write_to(&mut accounts.head.try_borrow_mut()?)?;
    if initialized {
        let recipient = if refund_to_payer {
            accounts.payer
        } else {
            accounts.refund
        };
        close_account(accounts.previous, recipient)?;
    }
    Ok(())
}

/// Checks that `head` is `owner`'s canonical head PDA and returns its bump.
fn verify_head_pda(head: &AccountView, owner: &Address) -> Result<u8, ProgramError> {
    let (expected, bump) =
        Address::find_program_address(&[HEAD_PDA_SEED, owner.as_ref()], &crate::ID);
    if head.address() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

/// Loads the upload to publish: unsealed, the owner's, complete and hashing
/// to the approved hash.
fn load_replacement(
    accounts: &ApplyAccounts,
    data: &ApplyData,
) -> Result<BufferHeader, ProgramError> {
    let header = load_buffer(accounts.buffer)?;
    if header.is_sealed() {
        return Err(fail(StorageError::Sealed));
    }
    if &header.owner != accounts.owner.address() {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_size = BufferHeader::LEN
        .checked_add(header.total_length() as usize)
        .ok_or_else(|| fail(StorageError::InvalidLength))?;
    if accounts.buffer.data_len() != expected_size {
        return Err(fail(StorageError::InvalidLength));
    }
    if data.approved_hash != header.data_hash {
        return Err(fail(StorageError::HashMismatch));
    }
    // A head that must refund itself could never be replaced again.
    if &header.refund == accounts.head.address() {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(header)
}

/// Checks the published record being replaced: writable, distinct from the
/// other accounts, sealed, the owner's, and naming `refund` as its destination.
///
/// Returns whether its rent goes to the apply payer. A destination that has
/// become a program cannot be credited, so the payer receives that refund and
/// the record stays replaceable.
fn check_predecessor(accounts: &ApplyAccounts) -> Result<bool, ProgramError> {
    let previous = &*accounts.previous;
    let refund = &*accounts.refund;
    require_writable(previous)?;
    for other in [&*accounts.head, &*accounts.buffer, &*accounts.payer] {
        require_distinct(previous, other)?;
    }
    for other in [&*accounts.head, &*accounts.buffer, previous] {
        require_distinct(refund, other)?;
    }
    let previous_header = load_buffer(previous)?;
    if !previous_header.is_sealed() {
        return Err(ProgramError::InvalidAccountData);
    }
    if &previous_header.owner != accounts.owner.address() {
        return Err(ProgramError::IllegalOwner);
    }
    if &previous_header.refund != refund.address() {
        return Err(fail(StorageError::RefundMismatch));
    }
    let refund_to_payer = refund.executable();
    if !refund_to_payer {
        require_writable(refund)?;
    }
    Ok(refund_to_payer)
}

/// Funds, allocates and assigns the owner's head PDA.
fn create_head(accounts: &ApplyAccounts, bump: u8) -> ProgramResult {
    top_up_rent(accounts.payer, accounts.head, Head::LEN)?;
    let bump_seed = [bump];
    let seeds = [
        Seed::from(HEAD_PDA_SEED),
        Seed::from(accounts.owner.address().as_ref()),
        Seed::from(bump_seed.as_slice()),
    ];
    allocate_and_assign(accounts.head, Head::LEN, &[Signer::from(seeds.as_slice())])
}
