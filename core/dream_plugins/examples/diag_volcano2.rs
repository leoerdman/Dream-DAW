// Diagnostic test: identifies exact crash point in FabFilter Volcano 2 loading.
// Uses eprintln! (stderr, unbuffered) at each step so output survives SIGSEGV.

use std::ffi::c_void;
use std::os::raw::c_char;
use std::ptr;

#[repr(C)]
struct FUnknown {
    vtbl: *const FUnknownVtbl,
}
#[repr(C)]
struct FUnknownVtbl {
    query_interface: unsafe extern "C" fn(*mut FUnknown, *const c_char, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "C" fn(*mut FUnknown) -> u32,
    release: unsafe extern "C" fn(*mut FUnknown) -> u32,
}
#[repr(C)]
struct PClassInfo {
    cid: [u8; 16],
    cardinality: i32,
    category: [i8; 32],
    name: [i8; 64],
}

fn main() {
    let plugin_path = "/Library/Audio/Plug-Ins/VST3/FabFilter Volcano 2.vst3";
    let binary_path = format!("{}/Contents/MacOS/FabFilter Volcano 2", plugin_path);

    eprintln!("DIAG: Loading library: {}", binary_path);
    let library = unsafe { libloading::Library::new(&binary_path) };
    let library = match library {
        Ok(l) => { eprintln!("DIAG: Library loaded OK"); l }
        Err(e) => { eprintln!("DIAG: Library load FAILED: {}", e); return; }
    };

    // bundleEntry
    eprintln!("DIAG: Looking for bundleEntry...");
    if let Ok(entry_fn) = unsafe {
        library.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"bundleEntry\0")
    } {
        eprintln!("DIAG: bundleEntry found, creating CFBundleRef...");
        let bundle_ref = create_cf_bundle_ref(plugin_path);
        eprintln!("DIAG: CFBundleRef: {:p}", bundle_ref);
        eprintln!("DIAG: Calling bundleEntry...");
        let result = unsafe { entry_fn(bundle_ref) };
        eprintln!("DIAG: bundleEntry returned: {}", result);
    } else {
        eprintln!("DIAG: No bundleEntry symbol");
    }

    // GetPluginFactory
    eprintln!("DIAG: Looking for GetPluginFactory...");
    let get_factory: libloading::Symbol<unsafe extern "C" fn() -> *mut c_void> = match unsafe {
        library.get(b"GetPluginFactory\0")
    } {
        Ok(f) => { eprintln!("DIAG: GetPluginFactory found"); f }
        Err(e) => { eprintln!("DIAG: GetPluginFactory NOT FOUND: {}", e); return; }
    };

    eprintln!("DIAG: Calling GetPluginFactory...");
    let factory_raw = unsafe { get_factory() };
    eprintln!("DIAG: Factory: {:p}", factory_raw);
    if factory_raw.is_null() {
        eprintln!("DIAG: Factory is NULL");
        return;
    }

    // Read factory vtbl
    let factory = factory_raw as *mut FUnknown;
    eprintln!("DIAG: Factory vtbl: {:p}", unsafe { (*factory).vtbl });

    // count_classes is at offset 4 (after QI, AddRef, Release, GetFactoryInfo)
    // But we don't have IPluginFactory vtbl here. Let me just read count_classes
    // through raw offsets.

    // Actually let me define minimal versions
    #[repr(C)]
    struct IPluginFactory {
        vtbl: *const IPluginFactoryVtbl,
    }
    #[repr(C)]
    struct IPluginFactoryVtbl {
        query_interface: unsafe extern "C" fn(*mut IPluginFactory, *const c_char, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
        release: unsafe extern "C" fn(*mut IPluginFactory) -> u32,
        get_factory_info: unsafe extern "C" fn(*mut IPluginFactory, *mut c_void) -> i32,
        count_classes: unsafe extern "C" fn(*mut IPluginFactory) -> i32,
        get_class_info: unsafe extern "C" fn(*mut IPluginFactory, i32, *mut PClassInfo) -> i32,
        create_instance: unsafe extern "C" fn(*mut IPluginFactory, *const [u8; 16], *const c_char, *mut *mut c_void) -> i32,
    }

    let factory = factory_raw as *mut IPluginFactory;

    eprintln!("DIAG: Calling count_classes...");
    let count = unsafe { ((*(*factory).vtbl).count_classes)(factory) };
    eprintln!("DIAG: count_classes = {}", count);

    for idx in 0..count.max(0) {
        let mut cls = PClassInfo {
            cid: [0; 16],
            cardinality: 0,
            category: [0; 32],
            name: [0; 64],
        };
        eprintln!("DIAG: Calling get_class_info({})...", idx);
        let r = unsafe { ((*(*factory).vtbl).get_class_info)(factory, idx, &mut cls) };
        eprintln!("DIAG: get_class_info({}) = {}", idx, r);

        let name = {
            let end = cls.name.iter().position(|&c| c == 0).unwrap_or(cls.name.len());
            String::from_utf8_lossy(&cls.name[..end].iter().map(|&c| c as u8).collect::<Vec<u8>>()).to_string()
        };
        let cat = {
            let end = cls.category.iter().position(|&c| c == 0).unwrap_or(cls.category.len());
            String::from_utf8_lossy(&cls.category[..end].iter().map(|&c| c as u8).collect::<Vec<u8>>()).to_string()
        };
        eprintln!("DIAG: Class {}: name='{}' category='{}'", idx, name, cat);

        // IID for IComponent
        let iid_icomponent: [u8; 16] = [
            0xE8, 0x31, 0xFF, 0x31, 0xF2, 0xD5, 0x40, 0x78,
            0xBC, 0xA2, 0x83, 0x1B, 0x09, 0x24, 0xDB, 0xA1,
        ];

        let mut comp: *mut c_void = ptr::null_mut();
        eprintln!("DIAG: Calling createInstance({}, IID_ICOMPONENT)...", idx);
        let ci_r = unsafe {
            ((*(*factory).vtbl).create_instance)(
                factory,
                &cls.cid,
                iid_icomponent.as_ptr() as *const c_char,
                &mut comp,
            )
        };
        eprintln!("DIAG: createInstance result = {}, ptr = {:p}", ci_r, comp);

        if ci_r == 0 && !comp.is_null() {
            eprintln!("DIAG: SUCCESS — IComponent created for class {}", idx);
            // Release it
            let unk = comp as *mut FUnknown;
            unsafe { ((*(*unk).vtbl).release)(unk) };
            eprintln!("DIAG: Released IComponent");
        }
    }

    eprintln!("DIAG: All done, exiting normally");
}

fn create_cf_bundle_ref(path: &str) -> *mut c_void {
    use std::ffi::CString;
    unsafe extern "C" {
        fn CFStringCreateWithCString(alloc: *mut c_void, c_str: *const c_char, encoding: u32) -> *mut c_void;
        fn CFURLCreateWithFileSystemPath(alloc: *mut c_void, path: *mut c_void, style: i32, is_dir: bool) -> *mut c_void;
        fn CFBundleCreate(alloc: *mut c_void, url: *mut c_void) -> *mut c_void;
        fn CFRelease(cf: *mut c_void);
    }
    let c_path = CString::new(path).unwrap();
    unsafe {
        let cf_str = CFStringCreateWithCString(ptr::null_mut(), c_path.as_ptr(), 0x08000100);
        if cf_str.is_null() { return ptr::null_mut(); }
        let url = CFURLCreateWithFileSystemPath(ptr::null_mut(), cf_str, 0, true);
        CFRelease(cf_str);
        if url.is_null() { return ptr::null_mut(); }
        let bundle = CFBundleCreate(ptr::null_mut(), url);
        CFRelease(url);
        bundle
    }
}
