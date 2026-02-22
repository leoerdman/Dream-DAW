use core::ffi::{c_char, c_void};
use std::ptr;

use crate::vst3::com_abi::{
    IParamValueQueue, IParamValueQueueVtbl, IParameterChanges, IParameterChangesVtbl,
    K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_OK, MAX_HOST_PARAM_CHANGES, MAX_POINTS_PER_QUEUE,
    Tresult,
};

#[repr(C)]
#[derive(Clone, Copy)]
struct HostParamValueQueue {
    vtbl: *const IParamValueQueueVtbl,
    ref_count: u32,
    param_id: u32,
    point_count: i32,
    sample_offsets: [i32; MAX_POINTS_PER_QUEUE],
    values: [f64; MAX_POINTS_PER_QUEUE],
}

impl HostParamValueQueue {
    const fn empty() -> Self {
        Self {
            vtbl: &HOST_PARAM_VALUE_QUEUE_VTBL,
            ref_count: 1,
            param_id: 0,
            point_count: 0,
            sample_offsets: [0i32; MAX_POINTS_PER_QUEUE],
            values: [0.0f64; MAX_POINTS_PER_QUEUE],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HostParameterChanges {
    vtbl: *const IParameterChangesVtbl,
    ref_count: u32,
    pub(crate) queue_count: i32,
    queues: [HostParamValueQueue; MAX_HOST_PARAM_CHANGES],
}

impl HostParameterChanges {
    pub fn from_pending(changes: &[(u32, f64)]) -> Self {
        let mut this = Self {
            vtbl: &HOST_PARAMETER_CHANGES_VTBL,
            ref_count: 1,
            queue_count: 0,
            queues: [HostParamValueQueue::empty(); MAX_HOST_PARAM_CHANGES],
        };
        for (slot, (param_id, value)) in changes.iter().take(MAX_HOST_PARAM_CHANGES).enumerate() {
            this.queues[slot].param_id = *param_id;
            this.queues[slot].sample_offsets[0] = 0;
            this.queues[slot].values[0] = value.clamp(0.0, 1.0);
            this.queues[slot].point_count = 1;
            this.queue_count += 1;
        }
        this
    }
}

unsafe extern "C" fn host_param_queue_query_interface(
    _this: *mut IParamValueQueue,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        // SAFETY: `obj` is non-null per guard above and points to out-param storage from caller.
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_param_queue_add_ref(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: VST3 host passes a valid `IParamValueQueue` allocated as `HostParamValueQueue`.
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    queue.ref_count = queue.ref_count.saturating_add(1);
    queue.ref_count
}

unsafe extern "C" fn host_param_queue_release(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: VST3 host passes a valid `IParamValueQueue` allocated as `HostParamValueQueue`.
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    queue.ref_count = queue.ref_count.saturating_sub(1);
    queue.ref_count
}

unsafe extern "C" fn host_param_queue_get_parameter_id(this: *mut IParamValueQueue) -> u32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to `HostParamValueQueue` per COM vtbl contract.
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    queue.param_id
}

unsafe extern "C" fn host_param_queue_get_point_count(this: *mut IParamValueQueue) -> i32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to `HostParamValueQueue` per COM vtbl contract.
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    queue.point_count
}

unsafe extern "C" fn host_param_queue_get_point(
    this: *mut IParamValueQueue,
    index: i32,
    sample_offset: *mut i32,
    value: *mut f64,
) -> Tresult {
    if this.is_null() || sample_offset.is_null() || value.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` is non-null and points to `HostParamValueQueue` per COM vtbl contract.
    let queue = unsafe { &*(this as *mut HostParamValueQueue) };
    if index < 0 || index >= queue.point_count || (index as usize) >= MAX_POINTS_PER_QUEUE {
        return K_RESULT_FALSE;
    }
    // SAFETY: output pointers are validated non-null above; writes are in-bounds scalar stores.
    unsafe {
        *sample_offset = queue.sample_offsets[index as usize];
        *value = queue.values[index as usize];
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_param_queue_add_point(
    this: *mut IParamValueQueue,
    sample_offset: i32,
    value: f64,
    index: *mut i32,
) -> Tresult {
    if this.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: VST3 host passes a valid `IParamValueQueue` allocated as `HostParamValueQueue`.
    let queue = unsafe { &mut *(this as *mut HostParamValueQueue) };
    let slot = queue.point_count as usize;
    if slot >= MAX_POINTS_PER_QUEUE {
        return K_RESULT_FALSE;
    }
    queue.sample_offsets[slot] = sample_offset;
    queue.values[slot] = value.clamp(0.0, 1.0);
    queue.point_count += 1;
    if !index.is_null() {
        // SAFETY: `index` is non-null by guard above and points to caller-owned out-param storage.
        unsafe {
            *index = slot as i32;
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_param_changes_query_interface(
    _this: *mut IParameterChanges,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        // SAFETY: `obj` is non-null per guard above and points to out-param storage from caller.
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_param_changes_add_ref(this: *mut IParameterChanges) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: VST3 host passes a valid `IParameterChanges` allocated as `HostParameterChanges`.
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    changes.ref_count = changes.ref_count.saturating_add(1);
    changes.ref_count
}

unsafe extern "C" fn host_param_changes_release(this: *mut IParameterChanges) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: VST3 host passes a valid `IParameterChanges` allocated as `HostParameterChanges`.
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    changes.ref_count = changes.ref_count.saturating_sub(1);
    changes.ref_count
}

unsafe extern "C" fn host_param_changes_get_parameter_count(this: *mut IParameterChanges) -> i32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to `HostParameterChanges` per COM vtbl contract.
    let changes = unsafe { &*(this as *mut HostParameterChanges) };
    changes.queue_count
}

unsafe extern "C" fn host_param_changes_get_parameter_data(
    this: *mut IParameterChanges,
    index: i32,
) -> *mut IParamValueQueue {
    if this.is_null() || index < 0 {
        return ptr::null_mut();
    }
    // SAFETY: `this` is non-null and points to `HostParameterChanges` per COM vtbl contract.
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    let idx = index as usize;
    if idx >= changes.queue_count as usize || idx >= MAX_HOST_PARAM_CHANGES {
        return ptr::null_mut();
    }
    (&mut changes.queues[idx] as *mut HostParamValueQueue).cast::<IParamValueQueue>()
}

unsafe extern "C" fn host_param_changes_add_parameter_data(
    this: *mut IParameterChanges,
    id: *mut u32,
    index: *mut i32,
) -> *mut IParamValueQueue {
    if this.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: `this` is non-null and points to `HostParameterChanges` per COM vtbl contract.
    let changes = unsafe { &mut *(this as *mut HostParameterChanges) };
    if changes.queue_count as usize >= MAX_HOST_PARAM_CHANGES {
        if !index.is_null() {
            // SAFETY: `index` is non-null by guard above and points to caller-owned out-param storage.
            unsafe {
                *index = -1;
            }
        }
        return ptr::null_mut();
    }
    let slot = changes.queue_count as usize;
    changes.queue_count += 1;
    let param_id = if id.is_null() {
        0
    } else {
        // SAFETY: `id` is non-null in this branch; we read a single scalar param id.
        unsafe { *id }
    };
    changes.queues[slot].param_id = param_id;
    changes.queues[slot].point_count = 0;
    if !index.is_null() {
        // SAFETY: `index` is non-null by guard above and points to caller-owned out-param storage.
        unsafe {
            *index = slot as i32;
        }
    }
    (&mut changes.queues[slot] as *mut HostParamValueQueue).cast::<IParamValueQueue>()
}

static HOST_PARAM_VALUE_QUEUE_VTBL: IParamValueQueueVtbl = IParamValueQueueVtbl {
    query_interface: host_param_queue_query_interface,
    add_ref: host_param_queue_add_ref,
    release: host_param_queue_release,
    get_parameter_id: host_param_queue_get_parameter_id,
    get_point_count: host_param_queue_get_point_count,
    get_point: host_param_queue_get_point,
    add_point: host_param_queue_add_point,
};

static HOST_PARAMETER_CHANGES_VTBL: IParameterChangesVtbl = IParameterChangesVtbl {
    query_interface: host_param_changes_query_interface,
    add_ref: host_param_changes_add_ref,
    release: host_param_changes_release,
    get_parameter_count: host_param_changes_get_parameter_count,
    get_parameter_data: host_param_changes_get_parameter_data,
    add_parameter_data: host_param_changes_add_parameter_data,
};
