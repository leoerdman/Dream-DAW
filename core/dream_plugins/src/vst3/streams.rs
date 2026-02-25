// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST3 Stream Implementations (IBStream)
// ═══════════════════════════════════════════════════════════════════════════
//
// Implements read-only and write-only IBStream COM objects used for
// state save/restore (IComponent::setState / IComponent::getState).

use std::ffi::{c_char, c_void};
use std::ptr;

use crate::vst3::com_abi::{
    IBStream, IBStreamVtbl, K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_NOT_IMPLEMENTED, K_RESULT_OK,
    K_SEEK_CUR, K_SEEK_END, K_SEEK_SET, Tresult,
};

// ── HostReadStream (IBStream for setState) ─────────────────────────────
//
// Read-only IBStream backed by a `Vec<u8>`. Used to feed saved plugin
// state data back to `IComponent::setState` / `IEditController::setComponentState`.

#[repr(C)]
pub(crate) struct HostReadStream {
    vtbl: *const IBStreamVtbl,
    ref_count: u32,
    data: Vec<u8>,
    pos: usize,
}

impl HostReadStream {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            vtbl: &HOST_READ_STREAM_VTBL,
            ref_count: 1,
            data: bytes,
            pos: 0,
        }
    }
}

unsafe extern "C" fn stream_query_interface(
    _this: *mut IBStream,
    _iid: *const c_char,
    _obj: *mut *mut c_void,
) -> Tresult {
    // COM spec: *obj MUST be NULLed on failure.
    if !_obj.is_null() {
        // SAFETY: `_obj` was checked for null and points to caller-owned out-slot.
        unsafe {
            *_obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn stream_add_ref(this: *mut IBStream) -> u32 {
    // SAFETY: `this` originates from our COM object construction and is HostReadStream.
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    stream.ref_count = stream.ref_count.saturating_add(1);
    stream.ref_count
}

unsafe extern "C" fn stream_release(this: *mut IBStream) -> u32 {
    // SAFETY: `this` originates from our COM object construction and is HostReadStream.
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    stream.ref_count = stream.ref_count.saturating_sub(1);
    stream.ref_count
}

pub(crate) unsafe extern "C" fn stream_read(
    this: *mut IBStream,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_read: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num_bytes < 0 {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` validated above and points to HostReadStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    let Ok(requested) = usize::try_from(num_bytes) else {
        return K_RESULT_FALSE;
    };
    let remaining = stream.data.len().saturating_sub(stream.pos);
    let to_copy = requested.min(remaining);
    if to_copy > 0 {
        // SAFETY: destination `buffer` validated non-null; source slice bounds are clamped by `to_copy`.
        unsafe {
            ptr::copy_nonoverlapping(
                stream.data.as_ptr().add(stream.pos),
                buffer as *mut u8,
                to_copy,
            );
        }
        stream.pos = stream.pos.saturating_add(to_copy);
    }
    if !num_bytes_read.is_null() {
        // SAFETY: checked for null; writes exactly one i32 out-parameter.
        unsafe {
            *num_bytes_read = i32::try_from(to_copy).unwrap_or(i32::MAX);
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn stream_write_noop(
    _this: *mut IBStream,
    _buffer: *mut c_void,
    _num_bytes: i32,
    num_bytes_written: *mut i32,
) -> Tresult {
    if !num_bytes_written.is_null() {
        // SAFETY: checked for null; writes one i32 out-parameter for noop write.
        unsafe {
            *num_bytes_written = 0;
        }
    }
    K_RESULT_FALSE
}

pub(crate) unsafe extern "C" fn stream_seek(
    this: *mut IBStream,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` validated above and points to HostReadStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostReadStream) };
    let len = i64::try_from(stream.data.len()).unwrap_or(i64::MAX);
    let base = match mode {
        K_SEEK_SET => 0_i64,
        K_SEEK_CUR => i64::try_from(stream.pos).unwrap_or(i64::MAX),
        K_SEEK_END => len,
        _ => return K_RESULT_FALSE,
    };
    let mut next = base.saturating_add(pos);
    if next < 0 {
        next = 0;
    }
    if next > len {
        next = len;
    }
    let Ok(next_pos) = usize::try_from(next) else {
        return K_RESULT_FALSE;
    };
    stream.pos = next_pos;
    if !result.is_null() {
        // SAFETY: checked for null; writes one i64 out-parameter.
        unsafe {
            *result = next;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn stream_tell(this: *mut IBStream, result: *mut i64) -> Tresult {
    if this.is_null() || result.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: pointers validated above; immutable borrow is valid for call duration.
    let stream = unsafe { &*(this as *mut HostReadStream) };
    // SAFETY: `result` validated non-null above.
    unsafe {
        *result = i64::try_from(stream.pos).unwrap_or(i64::MAX);
    }
    K_RESULT_OK
}

static HOST_READ_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: stream_query_interface,
    add_ref: stream_add_ref,
    release: stream_release,
    read: stream_read,
    write: stream_write_noop,
    seek: stream_seek,
    tell: stream_tell,
};

// ── HostWriteStream (IBStream for getState) ────────────────────────────
//
// Writable IBStream that collects plugin state into a `Vec<u8>`. Used by
// `IComponent::getState` and `IEditController::getState` to serialize
// plugin parameters and internal state for session save/restore.

/// Writable IBStream that appends into a `Vec<u8>` buffer.
#[repr(C)]
pub(crate) struct HostWriteStream {
    vtbl: *const IBStreamVtbl,
    ref_count: u32,
    data: Vec<u8>,
    pos: usize,
}

impl HostWriteStream {
    pub fn new() -> Self {
        Self {
            vtbl: &HOST_WRITE_STREAM_VTBL,
            ref_count: 1,
            data: Vec::with_capacity(8192),
            pos: 0,
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.data
    }
}

unsafe extern "C" fn write_stream_query_interface(
    _this: *mut IBStream,
    _iid: *const c_char,
    _obj: *mut *mut c_void,
) -> Tresult {
    // COM spec: *obj MUST be NULLed on failure.
    if !_obj.is_null() {
        // SAFETY: `_obj` was checked for null and points to caller-owned out-slot.
        unsafe {
            *_obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn write_stream_add_ref(this: *mut IBStream) -> u32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` validated non-null and points to HostWriteStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    stream.ref_count += 1;
    stream.ref_count
}

unsafe extern "C" fn write_stream_release(this: *mut IBStream) -> u32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` validated non-null and points to HostWriteStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    stream.ref_count = stream.ref_count.saturating_sub(1);
    stream.ref_count
}

unsafe extern "C" fn write_stream_read(
    _this: *mut IBStream,
    _buffer: *mut c_void,
    _num_bytes: i32,
    num_bytes_read: *mut i32,
) -> Tresult {
    // Write-only stream — reads are not supported.
    if !num_bytes_read.is_null() {
        // SAFETY: checked for null; writes one i32 out-parameter.
        unsafe {
            *num_bytes_read = 0;
        }
    }
    K_RESULT_NOT_IMPLEMENTED
}

unsafe extern "C" fn write_stream_write(
    this: *mut IBStream,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_written: *mut i32,
) -> Tresult {
    if this.is_null() || buffer.is_null() || num_bytes <= 0 {
        if !num_bytes_written.is_null() {
            // SAFETY: checked for null; writes one i32 out-parameter.
            unsafe {
                *num_bytes_written = 0;
            }
        }
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` validated above and points to HostWriteStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    // SAFETY: `buffer` validated non-null and `count` bytes provided by caller for this call.
    let Ok(count) = usize::try_from(num_bytes) else {
        if !num_bytes_written.is_null() {
            // SAFETY: checked for null; writes one i32 out-parameter.
            unsafe {
                *num_bytes_written = 0;
            }
        }
        return K_RESULT_FALSE;
    };
    let src = unsafe { std::slice::from_raw_parts(buffer as *const u8, count) };

    // If writing at pos < data.len(), overwrite in place; otherwise extend.
    if stream.pos < stream.data.len() {
        let overwrite_end = (stream.pos + count).min(stream.data.len());
        let overwrite_count = overwrite_end - stream.pos;
        stream.data[stream.pos..overwrite_end].copy_from_slice(&src[..overwrite_count]);
        if count > overwrite_count {
            stream.data.extend_from_slice(&src[overwrite_count..]);
        }
    } else {
        // Pad with zeros if seeking past end
        if stream.pos > stream.data.len() {
            stream.data.resize(stream.pos, 0);
        }
        stream.data.extend_from_slice(src);
    }
    stream.pos += count;

    if !num_bytes_written.is_null() {
        // SAFETY: checked for null; writes one i32 out-parameter.
        unsafe {
            *num_bytes_written = num_bytes;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn write_stream_seek(
    this: *mut IBStream,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` validated above and points to HostWriteStream allocated by host.
    let stream = unsafe { &mut *(this as *mut HostWriteStream) };
    let data_len_i64 = i64::try_from(stream.data.len()).unwrap_or(i64::MAX);
    let cur_pos_i64 = i64::try_from(stream.pos).unwrap_or(i64::MAX);
    let new_pos: i64 = match mode {
        K_SEEK_SET => pos,
        K_SEEK_CUR => cur_pos_i64.saturating_add(pos),
        K_SEEK_END => data_len_i64.saturating_add(pos),
        _ => return K_RESULT_FALSE,
    };
    if new_pos < 0 {
        return K_RESULT_FALSE;
    }
    let Ok(next_pos) = usize::try_from(new_pos) else {
        return K_RESULT_FALSE;
    };
    stream.pos = next_pos;
    if !result.is_null() {
        // SAFETY: checked for null; writes one i64 out-parameter.
        unsafe {
            *result = stream.pos as i64;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn write_stream_tell(this: *mut IBStream, result: *mut i64) -> Tresult {
    if this.is_null() || result.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: pointers validated above; immutable borrow is valid for call duration.
    let stream = unsafe { &*(this as *const HostWriteStream) };
    // SAFETY: `result` validated non-null above.
    unsafe {
        *result = i64::try_from(stream.pos).unwrap_or(i64::MAX);
    }
    K_RESULT_OK
}

static HOST_WRITE_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    query_interface: write_stream_query_interface,
    add_ref: write_stream_add_ref,
    release: write_stream_release,
    read: write_stream_read,
    write: write_stream_write,
    seek: write_stream_seek,
    tell: write_stream_tell,
};
