use core::ffi::{c_char, c_void};
use std::ptr;

use crate::instance::MidiEvent;
use crate::vst3::com_abi::{
    K_NO_INTERFACE, K_RESULT_FALSE, K_RESULT_OK, MAX_INPUT_EVENTS, Tresult,
};

const K_NOTE_ON_EVENT: u16 = 0;
const K_NOTE_OFF_EVENT: u16 = 1;
const K_LEGACY_MIDI_CC_OUT_EVENT: u16 = 65535;

#[repr(C)]
#[derive(Clone, Copy)]
struct Vst3Event {
    bus_index: i32,
    sample_offset: i32,
    ppq_position: f64,
    flags: u16,
    event_type: u16,
    _pad: [u8; 4],
    event_data: [u8; 24],
}

impl Vst3Event {
    const fn zeroed() -> Self {
        Self {
            bus_index: 0,
            sample_offset: 0,
            ppq_position: 0.0,
            flags: 0,
            event_type: 0,
            _pad: [0; 4],
            event_data: [0; 24],
        }
    }

    fn from_note_on(midi: &MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_NOTE_ON_EVENT;
        ev.flags = 1;

        let channel = (midi.channel & 0x0F) as i16;
        let pitch = midi.data[1] as i16;
        let velocity = midi.data[2] as f32 / 127.0;

        ev.event_data[0..2].copy_from_slice(&channel.to_ne_bytes());
        ev.event_data[2..4].copy_from_slice(&pitch.to_ne_bytes());
        ev.event_data[4..8].copy_from_slice(&0.0_f32.to_ne_bytes());
        ev.event_data[8..12].copy_from_slice(&velocity.to_ne_bytes());
        ev.event_data[12..16].copy_from_slice(&0_i32.to_ne_bytes());
        ev.event_data[16..20].copy_from_slice(&(-1_i32).to_ne_bytes());
        ev
    }

    fn from_note_off(midi: &MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_NOTE_OFF_EVENT;
        ev.flags = 1;

        let channel = (midi.channel & 0x0F) as i16;
        let pitch = midi.data[1] as i16;
        let velocity = midi.data[2] as f32 / 127.0;

        ev.event_data[0..2].copy_from_slice(&channel.to_ne_bytes());
        ev.event_data[2..4].copy_from_slice(&pitch.to_ne_bytes());
        ev.event_data[4..8].copy_from_slice(&velocity.to_ne_bytes());
        ev.event_data[8..12].copy_from_slice(&(-1_i32).to_ne_bytes());
        ev.event_data[12..16].copy_from_slice(&0.0_f32.to_ne_bytes());
        ev
    }

    fn from_midi_cc(midi: &MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_LEGACY_MIDI_CC_OUT_EVENT;
        ev.flags = 1;
        ev.event_data[0] = midi.data[1];
        ev.event_data[1] = midi.channel & 0x0F;
        ev.event_data[2] = midi.data[2];
        ev.event_data[3] = 0;
        ev
    }

    fn from_pitch_bend(midi: &MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_LEGACY_MIDI_CC_OUT_EVENT;
        ev.flags = 1;
        ev.event_data[0] = 128;
        ev.event_data[1] = midi.channel & 0x0F;
        ev.event_data[2] = midi.data[1];
        ev.event_data[3] = midi.data[2];
        ev
    }

    fn from_channel_aftertouch(midi: &MidiEvent) -> Self {
        let mut ev = Self::zeroed();
        ev.sample_offset = midi.sample_offset;
        ev.event_type = K_LEGACY_MIDI_CC_OUT_EVENT;
        ev.flags = 1;
        ev.event_data[0] = 129;
        ev.event_data[1] = midi.channel & 0x0F;
        ev.event_data[2] = midi.data[1];
        ev.event_data[3] = 0;
        ev
    }

    fn from_midi_event(midi: &MidiEvent) -> Option<Self> {
        let status = midi.data[0] & 0xF0;
        match status {
            0x90 if midi.data[2] > 0 => Some(Self::from_note_on(midi)),
            0x90 => Some(Self::from_note_off(midi)),
            0x80 => Some(Self::from_note_off(midi)),
            0xB0 => Some(Self::from_midi_cc(midi)),
            0xE0 => Some(Self::from_pitch_bend(midi)),
            0xD0 => Some(Self::from_channel_aftertouch(midi)),
            0xA0 => {
                let mut ev = Self::zeroed();
                ev.sample_offset = midi.sample_offset;
                ev.event_type = K_LEGACY_MIDI_CC_OUT_EVENT;
                ev.flags = 1;
                ev.event_data[0] = 130;
                ev.event_data[1] = midi.channel & 0x0F;
                ev.event_data[2] = midi.data[1];
                ev.event_data[3] = midi.data[2];
                Some(ev)
            }
            0xC0 => {
                let mut ev = Self::zeroed();
                ev.sample_offset = midi.sample_offset;
                ev.event_type = K_LEGACY_MIDI_CC_OUT_EVENT;
                ev.flags = 1;
                ev.event_data[0] = 131;
                ev.event_data[1] = midi.channel & 0x0F;
                ev.event_data[2] = midi.data[1];
                ev.event_data[3] = 0;
                Some(ev)
            }
            _ => None,
        }
    }
}

#[repr(C)]
struct IEventListVtbl {
    query_interface:
        unsafe extern "C" fn(*mut HostEventList, *const c_char, *mut *mut c_void) -> Tresult,
    add_ref: unsafe extern "C" fn(*mut HostEventList) -> u32,
    release: unsafe extern "C" fn(*mut HostEventList) -> u32,
    get_event_count: unsafe extern "C" fn(*mut HostEventList) -> i32,
    get_event: unsafe extern "C" fn(*mut HostEventList, i32, *mut Vst3Event) -> Tresult,
    add_event: unsafe extern "C" fn(*mut HostEventList, *const Vst3Event) -> Tresult,
}

#[repr(C)]
pub struct HostEventList {
    vtbl: *const IEventListVtbl,
    ref_count: u32,
    count: i32,
    events: Box<[Vst3Event]>,
}

impl HostEventList {
    pub fn empty() -> Self {
        Self {
            vtbl: &HOST_EVENT_LIST_VTBL,
            ref_count: 1,
            count: 0,
            events: vec![Vst3Event::zeroed(); MAX_INPUT_EVENTS].into_boxed_slice(),
        }
    }

    pub fn from_midi_events(midi_events: &[MidiEvent]) -> Self {
        let mut list = Self::empty();
        for midi in midi_events {
            let Ok(count) = usize::try_from(list.count) else {
                break;
            };
            if count >= MAX_INPUT_EVENTS {
                break;
            }
            if let Some(vst3_event) = Vst3Event::from_midi_event(midi) {
                list.events[count] = vst3_event;
                list.count += 1;
            }
        }
        list
    }

    pub fn has_events(&self) -> bool {
        self.count > 0
    }

    pub fn as_mut_void_ptr(&mut self) -> *mut c_void {
        (self as *mut Self).cast::<c_void>()
    }
}

unsafe extern "C" fn host_event_list_query_interface(
    _this: *mut HostEventList,
    _iid: *const c_char,
    obj: *mut *mut c_void,
) -> Tresult {
    if !obj.is_null() {
        // SAFETY: `obj` is non-null per guard above and points to caller-owned out-param storage.
        unsafe {
            *obj = ptr::null_mut();
        }
    }
    K_NO_INTERFACE
}

unsafe extern "C" fn host_event_list_add_ref(this: *mut HostEventList) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: `this` is non-null and points to a valid `HostEventList` per COM vtbl contract.
    let list = unsafe { &mut *this };
    list.ref_count = list.ref_count.saturating_add(1);
    list.ref_count
}

unsafe extern "C" fn host_event_list_release(this: *mut HostEventList) -> u32 {
    if this.is_null() {
        return 1;
    }
    // SAFETY: `this` is non-null and points to a valid `HostEventList` per COM vtbl contract.
    let list = unsafe { &mut *this };
    list.ref_count = list.ref_count.saturating_sub(1);
    list.ref_count
}

unsafe extern "C" fn host_event_list_get_event_count(this: *mut HostEventList) -> i32 {
    if this.is_null() {
        return 0;
    }
    // SAFETY: `this` is non-null and points to a valid `HostEventList` per COM vtbl contract.
    let list = unsafe { &*this };
    list.count
}

unsafe extern "C" fn host_event_list_get_event(
    this: *mut HostEventList,
    index: i32,
    event: *mut Vst3Event,
) -> Tresult {
    if this.is_null() || event.is_null() || index < 0 {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` is non-null and points to a valid `HostEventList` per COM vtbl contract.
    let list = unsafe { &*this };
    if index >= list.count {
        return K_RESULT_FALSE;
    }
    // SAFETY: `event` is validated non-null above and we copy a POD event by value.
    unsafe {
        *event = list.events[index as usize];
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_event_list_add_event(
    this: *mut HostEventList,
    event: *const Vst3Event,
) -> Tresult {
    if this.is_null() || event.is_null() {
        return K_RESULT_FALSE;
    }
    // SAFETY: `this` is non-null and points to a valid `HostEventList` per COM vtbl contract.
    let list = unsafe { &mut *this };
    if list.count as usize >= MAX_INPUT_EVENTS {
        return K_RESULT_FALSE;
    }
    // SAFETY: `event` is validated non-null above and points to a readable `Vst3Event`.
    list.events[list.count as usize] = unsafe { *event };
    list.count += 1;
    K_RESULT_OK
}

static HOST_EVENT_LIST_VTBL: IEventListVtbl = IEventListVtbl {
    query_interface: host_event_list_query_interface,
    add_ref: host_event_list_add_ref,
    release: host_event_list_release,
    get_event_count: host_event_list_get_event_count,
    get_event: host_event_list_get_event,
    add_event: host_event_list_add_event,
};
