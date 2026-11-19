//! Append-only uploads, published atomically through an owner-authorized
//! pointer. Publishing a replacement atomically closes its predecessor and
//! refunds its rent to whoever paid for that upload.
//!
//! Instruction tags are single bytes so deployed clients keep working:
//! 1 `store`, 2 `apply`, 3 `close_buffer`, 4 `create_buffer`, 5 `close_pointer`.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("Stor9L8wQBAGcAcoUcADt5sWYYaEA65Ws2Cgt5UUqXj");

#[program]
pub mod storage {
    use super::*;

    /// Appends a later chunk to an unpublished buffer.
    #[instruction(discriminator = 1)]
    pub fn store(ctx: Context<Store>, data: StoreInstructionData) -> Result<()> {
        process_store(ctx, data)
    }

    /// Publishes a complete upload and closes the record it replaces.
    #[instruction(discriminator = 2)]
    pub fn apply(ctx: Context<Apply>, data: ApplyInstructionData) -> Result<()> {
        process_apply(ctx, data)
    }

    /// Cancels an unpublished upload, refunding its rent destination.
    #[instruction(discriminator = 3)]
    pub fn close_buffer(ctx: Context<CloseBuffer>) -> Result<()> {
        process_close_buffer(ctx)
    }

    /// Closes the owner's pointer and its current record.
    #[instruction(discriminator = 5)]
    pub fn close_pointer(ctx: Context<ClosePointer>) -> Result<()> {
        process_close_pointer(ctx)
    }

    /// Creates a buffer with the first chunk of an upload.
    #[instruction(discriminator = 4)]
    pub fn create_buffer(ctx: Context<CreateBuffer>, data: StoreInstructionData) -> Result<()> {
        process_create_buffer(ctx, data)
    }
}
