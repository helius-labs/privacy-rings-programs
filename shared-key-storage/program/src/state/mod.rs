//! Account layouts. Both match the deployed program byte for byte.

mod buffer;
mod head;

pub use buffer::BufferHeader;
pub use head::Head;
use pinocchio::Address;

/// Every chunk but the last is exactly this long, so the chained hash depends
/// only on the bytes, and one `store` fits a 1,232-byte transaction with two
/// signers and compute budget instructions.
pub const CHUNK_LEN: usize = 768;
/// A buffer account, header included, is at most 10 MiB.
pub const MAX_RECORD_LEN: usize = 10 * 1024 * 1024 - BufferHeader::LEN;
pub const HEAD_PDA_SEED: &[u8] = b"head";
/// The predecessor of an owner's first record and the expected predecessor of
/// its first publication.
pub const NO_RECORD: Address = Address::new_from_array([0; 32]);
