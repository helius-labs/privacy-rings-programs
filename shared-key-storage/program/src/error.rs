use pinocchio::error::ProgramError;
use thiserror::Error;

/// Custom errors, returned as `ProgramError::Custom(code)`. The codes are part
/// of the deployed interface: never renumber or reorder them.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[repr(u32)]
pub enum StorageError {
    #[error("buffer is sealed")]
    Sealed = 7000,
    #[error("chunk offset is not the buffer's current length")]
    InvalidOffset = 7001,
    #[error("invalid chunk or record length")]
    InvalidLength = 7002,
    #[error("approved hash does not match the uploaded bytes")]
    HashMismatch = 7003,
    #[error("head does not match the expected predecessor and revision")]
    StaleHead = 7004,
    #[error("upload metadata differs from the first chunk")]
    MetadataMismatch = 7005,
    #[error("signer is not the buffer's rent payer")]
    PayerMismatch = 7006,
    #[error("account is not the buffer's refund destination")]
    RefundMismatch = 7007,
}

impl StorageError {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Sealed => "Sealed",
            Self::InvalidOffset => "InvalidOffset",
            Self::InvalidLength => "InvalidLength",
            Self::HashMismatch => "HashMismatch",
            Self::StaleHead => "StaleHead",
            Self::MetadataMismatch => "MetadataMismatch",
            Self::PayerMismatch => "PayerMismatch",
            Self::RefundMismatch => "RefundMismatch",
        }
    }
}

impl From<StorageError> for ProgramError {
    fn from(error: StorageError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

/// Logs the error name and converts it, so a failed transaction says which
/// check rejected it.
pub fn fail(error: StorageError) -> ProgramError {
    solana_msg::sol_log(error.name());
    error.into()
}
