use core::mem::{align_of, size_of};

use pinocchio::{error::ProgramError, Address, ProgramResult};
use wincode::{SchemaRead, SchemaWrite, ZeroCopy};

use super::NO_RECORD;

const HEAD_DISCRIMINATOR: [u8; 8] = *b"STORHEAD";

/// The owner's published record, at the `[HEAD_PDA_SEED, owner]` PDA. Created
/// by the first `apply` and never closed.
///
/// `revision` is a byte array so the layout has alignment 1 and no padding.
/// There is no stored bump: deployed heads are exactly 48 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
#[wincode(assert_zero_copy)]
#[repr(C)]
pub struct Head {
    pub discriminator: [u8; 8],
    pub current: Address,
    /// Increments on every publication, starting at 1, so an approval signed
    /// against an older head fails even if a closed record address is reused.
    pub revision: [u8; 8],
}

// Deployed heads are 48 bytes; the layout must never change that.
const _: () = assert!(Head::LEN == 48);
const _: () = assert!(align_of::<Head>() == 1);

impl Head {
    pub const LEN: usize = size_of::<Self>();

    pub fn new(current: Address, revision: u64) -> Self {
        Self {
            discriminator: HEAD_DISCRIMINATOR,
            current,
            revision: revision.to_le_bytes(),
        }
    }

    pub fn revision(&self) -> u64 {
        u64::from_le_bytes(self.revision)
    }

    /// Reads and validates a published head. A written head always names a
    /// record and has a revision of at least 1.
    pub fn read_from(account_data: &[u8]) -> Result<Self, ProgramError> {
        if account_data.len() != Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let head = *Self::from_bytes(account_data).map_err(|_| ProgramError::InvalidAccountData)?;
        if head.discriminator != HEAD_DISCRIMINATOR
            || head.current == NO_RECORD
            || head.revision() == 0
        {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(head)
    }

    /// Overwrites the head account's data.
    pub fn write_to(&self, account_data: &mut [u8]) -> ProgramResult {
        *Self::from_bytes_mut(account_data).map_err(|_| ProgramError::InvalidAccountData)? = *self;
        Ok(())
    }
}
