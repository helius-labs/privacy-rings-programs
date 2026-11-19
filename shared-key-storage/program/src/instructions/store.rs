use pinocchio::{error::ProgramError, AccountView, ProgramResult, Resize};
use solana_sha256_hasher::hashv;

use super::shared::{
    allocate_and_assign, load_buffer, require_distinct, require_empty_system_account,
    require_payer, require_refund_destination, require_signers, require_writable, top_up_rent,
};
use crate::{
    error::{fail, StorageError},
    instruction::StoreData,
    state::{BufferHeader, CHUNK_LEN, MAX_RECORD_LEN},
};

/// Accounts for `store`, in order; trailing accounts are ignored.
pub struct StoreAccounts<'a> {
    /// Writable signer: a fresh keypair on the first chunk.
    pub buffer: &'a mut AccountView,
    /// Writable signer, the same for every chunk.
    pub payer: &'a mut AccountView,
    /// Fixed by the first chunk and repeated on every later one.
    pub refund: &'a mut AccountView,
}

impl<'a> StoreAccounts<'a> {
    pub fn parse(accounts: &'a mut [AccountView]) -> Result<Self, ProgramError> {
        let [buffer, payer, system_program, refund, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        require_signers([buffer, payer])?;
        require_writable(buffer)?;
        require_payer(payer, system_program)?;
        require_distinct(buffer, payer)?;
        Ok(Self {
            buffer,
            payer,
            refund,
        })
    }
}

/// Appends `chunk` to an unpublished buffer, creating the buffer on the first chunk.
///
/// Steps:
/// 1. Reject an empty or oversized chunk and an invalid total length.
/// 2. Parse and check the accounts.
/// 3. Load the buffer's header, or start one on the first chunk.
/// 4. Require an unsealed buffer whose metadata and payer match this chunk's.
/// 5. Require the chunk to start at the current end and keep every non-final chunk full.
/// 6. Chain the chunk into the hash, then grow the buffer, topping up its rent.
/// 7. Write the header and the chunk.
pub fn process_store(accounts: &mut [AccountView], data: StoreData, chunk: &[u8]) -> ProgramResult {
    // 1. Lengths fail before any account is read.
    let total_length = data.total_length as usize;
    if chunk.is_empty()
        || chunk.len() > CHUNK_LEN
        || total_length == 0
        || total_length > MAX_RECORD_LEN
    {
        return Err(fail(StorageError::InvalidLength));
    }
    // 2. Signatures, writability, payer and System Program.
    let accounts = StoreAccounts::parse(accounts)?;
    // 3. An account this program owns is an upload in progress; anything else
    //    must be an empty System Program account to create one in.
    let initialized = accounts.buffer.owned_by(&crate::ID);
    let mut header = if initialized {
        load_buffer(accounts.buffer)?
    } else {
        require_empty_system_account(accounts.buffer)?;
        require_refund_destination(accounts.refund, accounts.buffer)?;
        BufferHeader::new(
            data.owner,
            *accounts.payer.address(),
            *accounts.refund.address(),
            data.previous,
            data.total_length,
        )
    };
    // 4. Every chunk repeats the first chunk's metadata.
    if header.is_sealed() {
        return Err(fail(StorageError::Sealed));
    }
    if header.owner != data.owner
        || header.previous != data.previous
        || header.total_length() != data.total_length
        || &header.refund != accounts.refund.address()
    {
        return Err(fail(StorageError::MetadataMismatch));
    }
    // One payer funds the whole buffer, so one account receives every refund.
    if &header.payer != accounts.payer.address() {
        return Err(fail(StorageError::PayerMismatch));
    }
    // 5. Append only at the current end.
    let written = if initialized {
        accounts
            .buffer
            .data_len()
            .checked_sub(BufferHeader::LEN)
            .ok_or(ProgramError::InvalidAccountData)?
    } else {
        0
    };
    let offset = data.offset as usize;
    if offset != written {
        return Err(fail(StorageError::InvalidOffset));
    }
    let end = offset
        .checked_add(chunk.len())
        .ok_or_else(|| fail(StorageError::InvalidLength))?;
    // Only the final chunk may be short, so the bytes alone fix the hash.
    if end > total_length || (chunk.len() != CHUNK_LEN && end != total_length) {
        return Err(fail(StorageError::InvalidLength));
    }
    let start = BufferHeader::LEN
        .checked_add(offset)
        .ok_or_else(|| fail(StorageError::InvalidLength))?;
    let size = BufferHeader::LEN
        .checked_add(end)
        .ok_or_else(|| fail(StorageError::InvalidLength))?;
    // 6. Grow the account to hold the chunk.
    header.data_hash = hashv(&[&header.data_hash, chunk]).to_bytes();
    top_up_rent(accounts.payer, accounts.buffer, size)?;
    if initialized {
        accounts.buffer.resize(size)?;
    } else {
        allocate_and_assign(accounts.buffer, size, &[])?;
    }
    // 7. Write the header and the chunk.
    let mut buffer_bytes = accounts.buffer.try_borrow_mut()?;
    header.write_to(&mut buffer_bytes)?;
    buffer_bytes
        .get_mut(start..size)
        .ok_or(ProgramError::InvalidAccountData)?
        .copy_from_slice(chunk);
    Ok(())
}
