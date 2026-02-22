use std::ptr;

// Opaque CoreFoundation types — only used as pointers.
#[repr(C)]
pub struct __CFBundle {
    _private: [u8; 0],
}
#[repr(C)]
pub struct __CFURL {
    _private: [u8; 0],
}
#[repr(C)]
pub struct __CFAllocator {
    _private: [u8; 0],
}

pub type CFBundleRef = *mut __CFBundle;
pub type CFURLRef = *mut __CFURL;
pub type CFAllocatorRef = *mut __CFAllocator;
pub type CFIndex = isize;
pub type Boolean = u8;

unsafe extern "C" {
    pub static kCFAllocatorDefault: CFAllocatorRef;
    pub fn CFURLCreateFromFileSystemRepresentation(
        allocator: CFAllocatorRef,
        buffer: *const u8,
        buf_len: CFIndex,
        is_directory: Boolean,
    ) -> CFURLRef;
    pub fn CFBundleCreate(allocator: CFAllocatorRef, bundle_url: CFURLRef) -> CFBundleRef;
    pub fn CFRelease(cf: *mut core::ffi::c_void);
}

/// RAII guard: releases the CFBundleRef on drop.
pub struct CFBundleRefGuard(pub *mut core::ffi::c_void);

impl Drop for CFBundleRefGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

unsafe impl Send for CFBundleRefGuard {}
unsafe impl Sync for CFBundleRefGuard {}

/// Creates a CFBundleRef for the given filesystem path.
/// Returns a raw `*mut c_void` suitable for passing to `bundleEntry()`.
/// Returns null on failure.
pub fn create_cf_bundle_ref(path: &str) -> *mut core::ffi::c_void {
    let path_bytes = path.as_bytes();
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(
            kCFAllocatorDefault,
            path_bytes.as_ptr(),
            path_bytes.len() as CFIndex,
            1,
        );
        if url.is_null() {
            log::warn!("[VST3] CFURLCreate failed for path: {}", path);
            return ptr::null_mut();
        }
        let bundle = CFBundleCreate(kCFAllocatorDefault, url);
        CFRelease(url as *mut core::ffi::c_void);
        if bundle.is_null() {
            log::warn!("[VST3] CFBundleCreate failed for path: {}", path);
            return ptr::null_mut();
        }
        bundle as *mut core::ffi::c_void
    }
}
