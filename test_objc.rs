use objc::runtime::{Class, Object, BOOL, YES};
use objc::{msg_send, sel, sel_impl};
use std::ffi::CStr;

pub unsafe fn test(event: *mut Object) {
    let window: *mut Object = msg_send![event, window];
    if !window.is_null() {
        let first_responder: *mut Object = msg_send![window, firstResponder];
        if !first_responder.is_null() {
            let class_ptr: *const Class = msg_send![first_responder, class];
            let c_name = objc::runtime::class_getName(class_ptr);
            let name = CStr::from_ptr(c_name).to_string_lossy();
            if name.contains("WebView") {
                println!("WebView!");
            }
        }
    }
}
