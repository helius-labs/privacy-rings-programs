use anchor_lang::prelude::*;

/// Custom errors, `ProgramError::Custom(7000 + n)`. The first eight keep the
/// codes the pinocchio program used; append new variants at the end.
#[error_code(offset = 7000)]
pub enum StorageError {
    #[msg("buffer is sealed")]
    Sealed,
    #[msg("chunk offset is not the buffer's current length")]
    InvalidOffset,
    #[msg("invalid chunk or record length")]
    InvalidLength,
    #[msg("approved hash does not match the uploaded bytes")]
    HashMismatch,
    #[msg("pointer does not match the expected predecessor and revision")]
    StaleHead,
    #[msg("upload metadata differs from the first chunk")]
    MetadataMismatch,
    #[msg("signer is not the buffer's rent payer")]
    PayerMismatch,
    #[msg("account is not the buffer's refund destination")]
    RefundMismatch,
    #[msg("refund destination must be a plain System Program account other than the buffer")]
    InvalidRefundDestination,
    #[msg("a record cannot name its owner's pointer as refund destination")]
    RefundIsPointer,
    #[msg("account is not the expected predecessor")]
    PredecessorMismatch,
    #[msg("predecessor is not a sealed record of this owner")]
    InvalidPredecessor,
    #[msg("account must be writable")]
    NotWritable,
    #[msg("the first publication has no predecessor or refund destination")]
    InvalidFirstPublication,
}
