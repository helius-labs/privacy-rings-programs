use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    instruction::{ApplyData, InstructionTag, StoreData},
    instructions::{process_apply, process_close, process_store},
};

/// Decodes the instruction data, then hands off to the instruction. Malformed
/// data fails before any account is read.
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if program_id != &crate::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (tag, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match InstructionTag::try_from(*tag)? {
        InstructionTag::Store => {
            let (data, chunk) = StoreData::parse(data)?;
            process_store(accounts, data, chunk)
        }
        InstructionTag::Apply => process_apply(accounts, ApplyData::from_bytes(data)?),
        InstructionTag::Close if data.is_empty() => process_close(accounts),
        InstructionTag::Close => Err(ProgramError::InvalidInstructionData),
    }
}
