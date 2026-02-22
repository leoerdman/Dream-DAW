use std::ffi::{c_char, c_void};
use std::ptr;

use log::info;

use crate::instance::PluginError;
use crate::vst3::com_abi::{
    FUnknown, IComponent, IID_IAUDIO_PROCESSOR, IID_ICOMPONENT, IID_IEDIT_CONTROLLER,
    IPluginFactory, K_RESULT_OK, PClassInfo, Tuid,
};
use crate::vst3::host_objects::host_application_ptr;

/// VST3 COM bootstrap following the official SDK initialization sequence.
///
/// Returns tuple:
/// `(factory_ptr, component_ptr, processor_ptr, controller_ptr,
///   processor_from_component_qi, controller_from_component_qi)`.
pub(crate) fn init_vst3_com(
    library: &libloading::Library,
) -> Result<(usize, usize, usize, usize, bool, bool), PluginError> {
    // SAFETY: symbol lookup is performed against a loaded dynamic library and type matches VST3 ABI.
    let get_factory: libloading::Symbol<unsafe extern "C" fn() -> *mut c_void> = unsafe {
        library.get(b"GetPluginFactory\0").map_err(|e| {
            PluginError::LoadFailed(format!("GetPluginFactory symbol lookup failed: {e}"))
        })?
    };

    // SAFETY: `get_factory` points to a VST3-exported function with declared ABI.
    let factory = unsafe { get_factory() as *mut IPluginFactory };
    if factory.is_null() {
        return Err(PluginError::LoadFailed(
            "GetPluginFactory returned null".to_string(),
        ));
    }

    let mut component_ptr: *mut c_void = ptr::null_mut();
    let mut processor_ptr: *mut c_void = ptr::null_mut();
    let mut processor_qi_from_component = false;
    let mut controller_qi_from_component = false;

    // SAFETY: factory pointer is validated non-null above and vtbl function follows VST3 ABI.
    let count = unsafe { ((*(*factory).vtbl).count_classes)(factory) }.max(0);
    info!("[VST3-COM] Factory returned {} classes", count);

    for idx in 0..count {
        let mut cls = PClassInfo {
            cid: [0; 16],
            cardinality: 0,
            category: [0; 32],
            name: [0; 64],
        };
        let class_ok =
            // SAFETY: factory pointer and class index are valid for VST3 `get_class_info` call.
            unsafe { ((*(*factory).vtbl).get_class_info)(factory, idx, &mut cls) } == K_RESULT_OK;
        if !class_ok {
            continue;
        }

        let class_name = {
            let end = cls
                .name
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(cls.name.len());
            String::from_utf8_lossy(
                &cls.name[..end]
                    .iter()
                    .map(|&c| c as u8)
                    .collect::<Vec<u8>>(),
            )
            .to_string()
        };
        let class_category = {
            let end = cls
                .category
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(cls.category.len());
            String::from_utf8_lossy(
                &cls.category[..end]
                    .iter()
                    .map(|&c| c as u8)
                    .collect::<Vec<u8>>(),
            )
            .to_string()
        };
        info!(
            "[VST3-COM] Class #{}: name='{}' category='{}'",
            idx, class_name, class_category
        );

        // SAFETY: factory pointer/cid/iid are valid under VST3 ABI; out pointer is writable.
        let comp_ok = unsafe {
            ((*(*factory).vtbl).create_instance)(
                factory,
                &cls.cid,
                IID_ICOMPONENT.as_ptr() as *const c_char,
                &mut component_ptr,
            )
        } == K_RESULT_OK
            && !component_ptr.is_null();

        if comp_ok {
            info!(
                "[VST3-COM]   -> IComponent (factory, Strategy A): OK ({:p})",
                component_ptr
            );
            // SAFETY: `component_ptr` is a live COM object supporting `FUnknown`.
            let qi_result = unsafe {
                let comp_as_unk = component_ptr as *mut FUnknown;
                ((*(*comp_as_unk).vtbl).query_interface)(
                    comp_as_unk,
                    IID_IAUDIO_PROCESSOR.as_ptr() as *const c_char,
                    &mut processor_ptr,
                )
            };
            let processor_from_qi = qi_result == K_RESULT_OK && !processor_ptr.is_null();
            if processor_from_qi {
                processor_qi_from_component = true;
                info!(
                    "[VST3-COM]   -> IAudioProcessor (QI from component): OK ({:p})",
                    processor_ptr
                );
                break;
            } else {
                info!(
                    "[VST3-COM]   -> IAudioProcessor (QI from component): FAILED (result={})",
                    qi_result
                );
                // SAFETY: `comp_as_unk` is a valid COM object acquired above and can be released once.
                unsafe {
                    let comp_as_unk = component_ptr as *mut FUnknown;
                    ((*(*comp_as_unk).vtbl).release)(comp_as_unk);
                }
                component_ptr = ptr::null_mut();
                processor_ptr = ptr::null_mut();
                continue;
            }
        }

        // SAFETY: factory pointer/cid/iid are valid under VST3 ABI; out pointer is writable.
        let proc_ok = unsafe {
            ((*(*factory).vtbl).create_instance)(
                factory,
                &cls.cid,
                IID_IAUDIO_PROCESSOR.as_ptr() as *const c_char,
                &mut processor_ptr,
            )
        } == K_RESULT_OK
            && !processor_ptr.is_null();

        if proc_ok {
            info!(
                "[VST3-COM]   -> IAudioProcessor (factory, Strategy B): OK ({:p})",
                processor_ptr
            );
            // SAFETY: `processor_ptr` is a live COM object supporting `FUnknown`.
            let qi_result = unsafe {
                let proc_as_unk = processor_ptr as *mut FUnknown;
                ((*(*proc_as_unk).vtbl).query_interface)(
                    proc_as_unk,
                    IID_ICOMPONENT.as_ptr() as *const c_char,
                    &mut component_ptr,
                )
            };
            if qi_result == K_RESULT_OK && !component_ptr.is_null() {
                info!(
                    "[VST3-COM]   -> IComponent (QI from processor): OK ({:p})",
                    component_ptr
                );
            } else {
                info!("[VST3-COM]   -> IComponent (QI from processor): FAILED");
                component_ptr = ptr::null_mut();
            }
            break;
        }

        info!("[VST3-COM]   -> Both strategies failed for class #{}", idx);
    }

    if processor_ptr.is_null() {
        // SAFETY: factory is a valid COM object obtained above and must be released on failure path.
        unsafe {
            ((*(*factory).vtbl).release)(factory);
        }
        return Err(PluginError::LoadFailed(
            "Failed to instantiate VST3 IAudioProcessor".to_string(),
        ));
    }

    if !component_ptr.is_null() {
        let component = component_ptr as *mut IComponent;
        // SAFETY: component pointer is live and host_application_ptr returns valid host interface.
        let init_result =
            unsafe { ((*(*component).vtbl).initialize)(component, host_application_ptr()) };
        info!(
            "[VST3-COM] IComponent::initialize() result: {}",
            init_result
        );
    }

    let mut controller_ptr: *mut c_void = ptr::null_mut();

    if !component_ptr.is_null() {
        let component = component_ptr as *mut IComponent;
        let mut controller_cid: Tuid = [0; 16];
        // SAFETY: component is live and controller_cid points to writable storage.
        let cid_ok = unsafe {
            ((*(*component).vtbl).get_controller_class_id)(component, &mut controller_cid)
        } == K_RESULT_OK;
        info!("[VST3-COM] getControllerClassId: ok={}", cid_ok);

        if cid_ok {
            // SAFETY: factory pointer/cid/iid are valid under VST3 ABI; out pointer is writable.
            let create_result = unsafe {
                ((*(*factory).vtbl).create_instance)(
                    factory,
                    &controller_cid,
                    IID_IEDIT_CONTROLLER.as_ptr() as *const c_char,
                    &mut controller_ptr,
                )
            };
            if create_result == K_RESULT_OK && !controller_ptr.is_null() {
                info!(
                    "[VST3-COM] IEditController (factory by CID): OK ({:p})",
                    controller_ptr
                );
            } else {
                info!(
                    "[VST3-COM] IEditController (factory by CID): FAILED (result={})",
                    create_result
                );
                controller_ptr = ptr::null_mut();
            }
        }

        if controller_ptr.is_null() {
            // SAFETY: component is live; query_interface follows VST3 COM contract.
            let qi_result = unsafe {
                ((*(*component).vtbl).query_interface)(
                    component,
                    IID_IEDIT_CONTROLLER.as_ptr() as *const c_char,
                    &mut controller_ptr,
                )
            };
            if qi_result == K_RESULT_OK && !controller_ptr.is_null() {
                controller_qi_from_component = true;
                info!(
                    "[VST3-COM] IEditController (QI from component): OK ({:p})",
                    controller_ptr
                );
            } else {
                info!(
                    "[VST3-COM] IEditController (QI from component): FAILED (result={})",
                    qi_result
                );
                controller_ptr = ptr::null_mut();
            }
        }
    }

    if controller_ptr.is_null() && !processor_ptr.is_null() {
        // SAFETY: processor pointer is live; query_interface follows VST3 COM contract.
        let qi_result = unsafe {
            let proc_as_unk = processor_ptr as *mut FUnknown;
            ((*(*proc_as_unk).vtbl).query_interface)(
                proc_as_unk,
                IID_IEDIT_CONTROLLER.as_ptr() as *const c_char,
                &mut controller_ptr,
            )
        };
        if qi_result == K_RESULT_OK && !controller_ptr.is_null() {
            if processor_qi_from_component {
                controller_qi_from_component = true;
            }
            info!(
                "[VST3-COM] IEditController (QI from processor, last-resort): OK ({:p})",
                controller_ptr
            );
        } else {
            info!("[VST3-COM] IEditController: ALL strategies failed — no editor support");
            controller_ptr = ptr::null_mut();
        }
    }

    info!(
        "[VST3-COM] Final pointers: factory={:p} component={:p} processor={:p} controller={:p}",
        factory as *const c_void, component_ptr, processor_ptr, controller_ptr
    );

    Ok((
        factory as usize,
        component_ptr as usize,
        processor_ptr as usize,
        controller_ptr as usize,
        processor_qi_from_component,
        controller_qi_from_component,
    ))
}
