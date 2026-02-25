// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AudioUnit Host Bridge (macOS)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(not(target_os = "macos"))]
use crate::descriptor::PluginDescriptor;
#[cfg(not(target_os = "macos"))]
use crate::instance::PluginError;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void};
    use std::mem::{size_of, zeroed};

    use cocoa::appkit::{
        NSApp, NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreType, NSWindow,
        NSWindowStyleMask,
    };
    use cocoa::base::{NO, id, nil};
    use cocoa::foundation::{NSPoint, NSRect, NSSize, NSString};
    use uuid::Uuid;

    use crate::descriptor::PluginDescriptor;
    use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};

    type AudioComponent = *mut c_void;
    type AudioUnit = *mut c_void;
    type OSStatus = i32;

    const NO_ERR: OSStatus = 0;

    const K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT: u32 = 8;
    const K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK: u32 = 23;
    const K_AUDIO_UNIT_PROPERTY_COCOA_UI: u32 = 31;
    const K_AUDIO_UNIT_SCOPE_GLOBAL: u32 = 0;
    const K_AUDIO_UNIT_SCOPE_INPUT: u32 = 1;
    const K_AUDIO_UNIT_SCOPE_OUTPUT: u32 = 2;

    const K_AUDIO_FORMAT_LINEAR_PCM: u32 = 1_819_304_813; // 'lpcm'
    const K_AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
    const K_AUDIO_FORMAT_FLAG_IS_PACKED: u32 = 1 << 3;
    const K_AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED: u32 = 1 << 5;

    const K_AUDIO_TIME_STAMP_SAMPLE_TIME_VALID: u32 = 1 << 2;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioComponentDescription {
        component_type: u32,
        component_sub_type: u32,
        component_manufacturer: u32,
        component_flags: u32,
        component_flags_mask: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioStreamBasicDescription {
        m_sample_rate: f64,
        m_format_id: u32,
        m_format_flags: u32,
        m_bytes_per_packet: u32,
        m_frames_per_packet: u32,
        m_bytes_per_frame: u32,
        m_channels_per_frame: u32,
        m_bits_per_channel: u32,
        m_reserved: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioBuffer {
        m_number_channels: u32,
        m_data_byte_size: u32,
        m_data: *mut c_void,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioBufferList {
        m_number_buffers: u32,
        m_buffers: [AudioBuffer; 1],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioBufferListStereo {
        m_number_buffers: u32,
        m_buffers: [AudioBuffer; 2],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SMPTETime {
        m_subframes: i16,
        m_subframe_divisor: i16,
        m_counter: u32,
        m_type: u32,
        m_flags: u32,
        m_hours: i16,
        m_minutes: i16,
        m_seconds: i16,
        m_frames: i16,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioTimeStamp {
        m_sample_time: f64,
        m_host_time: u64,
        m_rate_scalar: f64,
        m_word_clock_time: u64,
        m_smpte_time: SMPTETime,
        m_flags: u32,
        m_reserved: u32,
    }

    type AURenderCallback = unsafe extern "C" fn(
        in_ref_con: *mut c_void,
        io_action_flags: *mut u32,
        in_time_stamp: *const AudioTimeStamp,
        in_bus_number: u32,
        in_number_frames: u32,
        io_data: *mut AudioBufferList,
    ) -> OSStatus;

    #[repr(C)]
    struct AURenderCallbackStruct {
        input_proc: Option<AURenderCallback>,
        input_proc_ref_con: *mut c_void,
    }

    #[repr(C)]
    struct AudioUnitCocoaViewInfo {
        m_cocoa_au_view_bundle_location: *const c_void,
        m_cocoa_au_view_class: [*const c_void; 1],
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    unsafe extern "C" {
        fn AudioComponentFindNext(
            in_component: AudioComponent,
            in_desc: *const AudioComponentDescription,
        ) -> AudioComponent;
        fn AudioComponentCopyName(
            in_component: AudioComponent,
            out_name: *mut *const c_void,
        ) -> OSStatus;
        fn AudioComponentInstanceNew(
            in_component: AudioComponent,
            out_instance: *mut AudioUnit,
        ) -> OSStatus;
        fn AudioComponentInstanceDispose(in_instance: AudioUnit) -> OSStatus;

        fn AudioUnitInitialize(ci: AudioUnit) -> OSStatus;
        fn AudioUnitUninitialize(ci: AudioUnit) -> OSStatus;
        fn AudioUnitRender(
            in_unit: AudioUnit,
            io_action_flags: *mut u32,
            in_time_stamp: *const AudioTimeStamp,
            in_output_bus_number: u32,
            in_number_frames: u32,
            io_data: *mut AudioBufferList,
        ) -> OSStatus;
        fn AudioUnitSetProperty(
            in_unit: AudioUnit,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            in_data: *const c_void,
            in_data_size: u32,
        ) -> OSStatus;
        fn AudioUnitGetPropertyInfo(
            in_unit: AudioUnit,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            out_data_size: *mut u32,
            out_writable: *mut u8,
        ) -> OSStatus;
        fn AudioUnitGetProperty(
            in_unit: AudioUnit,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            out_data: *mut c_void,
            io_data_size: *mut u32,
        ) -> OSStatus;

        // ── MIDI dispatch for AU instrument plugins (kAudioUnitType_MusicDevice) ──
        // Sends a single MIDI event to an AudioUnit. Parameters:
        //   in_unit: AU instance
        //   in_status: MIDI status byte (0x90=NoteOn, 0x80=NoteOff, 0xB0=CC, etc.)
        //   in_data1: first data byte (note number / CC number)
        //   in_data2: second data byte (velocity / CC value)
        //   in_offset_sample_frame: sample offset within current render buffer
        fn MusicDeviceMIDIEvent(
            in_unit: AudioUnit,
            in_status: u32,
            in_data1: u32,
            in_data2: u32,
            in_offset_sample_frame: u32,
        ) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringGetCString(
            the_string: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(cf: *mut c_void);
    }

    unsafe extern "C" {
        fn pthread_main_np() -> i32;
        fn objc_getClass(name: *const c_char) -> *const c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend() -> id;
    }

    mod ui {
        include!("au_host_ui_macos.rs");
    }
    use ui::{
        AuEditorWindow, add_subview, cocoa_view_frame, content_view_bounds,
        create_cocoa_view_for_unit, has_cocoa_ui_property, is_main_thread, set_view_autoresize_mask,
        set_view_frame,
    };

    fn osstatus_ok(status: OSStatus, ctx: &str) -> Result<(), PluginError> {
        if status == NO_ERR {
            Ok(())
        } else {
            Err(PluginError::InitFailed(format!(
                "{ctx} failed with OSStatus {status}"
            )))
        }
    }

    fn cfstring_to_rust(cf: *const c_void) -> Option<String> {
        if cf.is_null() {
            return None;
        }
        let mut buf = vec![0i8; 1024];
        // SAFETY: `cf` is a valid CFStringRef from CoreFoundation API.
        let ok = unsafe {
            CFStringGetCString(
                cf,
                buf.as_mut_ptr(),
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            )
        } != 0;
        if !ok {
            return None;
        }
        let bytes = buf
            .iter()
            .map(|c| c.cast_unsigned())
            .take_while(|b| *b != 0)
            .collect::<Vec<u8>>();
        String::from_utf8(bytes).ok()
    }

    #[inline]
    fn usize_to_u32_saturating(value: usize) -> u32 {
        u32::try_from(value).unwrap_or(u32::MAX)
    }

    fn normalize_name_key(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        for ch in raw.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
            }
        }
        out
    }

    fn fourcc_from_ascii(raw: &str) -> Option<u32> {
        let bytes = raw.as_bytes();
        if bytes.len() != 4 {
            return None;
        }
        Some(
            ((bytes[0] as u32) << 24)
                | ((bytes[1] as u32) << 16)
                | ((bytes[2] as u32) << 8)
                | (bytes[3] as u32),
        )
    }

    fn parse_au_unique_id(raw: &str) -> Option<AudioComponentDescription> {
        let trimmed = raw.trim();
        let rest = trimmed
            .strip_prefix("au:")
            .or_else(|| trimmed.strip_prefix("AU:"))
            .unwrap_or(trimmed);
        let mut parts = rest.split(':');
        let t = parts.next()?.trim();
        let st = parts.next()?.trim();
        let m = parts.next()?.trim();
        if parts.next().is_some() {
            return None;
        }
        Some(AudioComponentDescription {
            component_type: fourcc_from_ascii(t)?,
            component_sub_type: fourcc_from_ascii(st)?,
            component_manufacturer: fourcc_from_ascii(m)?,
            component_flags: 0,
            component_flags_mask: 0,
        })
    }

    fn find_component_by_unique_id(unique_id: &str) -> Option<AudioComponent> {
        let desc = parse_au_unique_id(unique_id)?;
        // SAFETY: direct query with fully specified AudioComponentDescription.
        let component = unsafe { AudioComponentFindNext(std::ptr::null_mut(), &desc) };
        if component.is_null() {
            None
        } else {
            Some(component)
        }
    }

    fn find_component_by_name_hint(
        path_stem: &str,
        descriptor_name: &str,
    ) -> Result<AudioComponent, PluginError> {
        let wildcard = AudioComponentDescription {
            component_type: 0,
            component_sub_type: 0,
            component_manufacturer: 0,
            component_flags: 0,
            component_flags_mask: 0,
        };
        let mut current: AudioComponent = std::ptr::null_mut();
        let mut best: Option<(AudioComponent, i32)> = None;
        let stem = path_stem.to_ascii_lowercase();
        let desc_name = descriptor_name.to_ascii_lowercase();
        let stem_key = normalize_name_key(path_stem);
        let desc_key = normalize_name_key(descriptor_name);

        loop {
            // SAFETY: AudioComponentFindNext accepts null for first iteration.
            let next = unsafe { AudioComponentFindNext(current, &wildcard) };
            if next.is_null() {
                break;
            }
            current = next;

            let mut cf_name: *const c_void = std::ptr::null();
            // SAFETY: `next` is a valid component handle.
            let status = unsafe { AudioComponentCopyName(next, &mut cf_name) };
            if status != NO_ERR || cf_name.is_null() {
                continue;
            }
            let name = cfstring_to_rust(cf_name).unwrap_or_default();
            // SAFETY: `cf_name` returned retained by CopyName and must be released once.
            unsafe { CFRelease(cf_name as *mut c_void) };
            let lower = name.to_ascii_lowercase();
            if lower.is_empty() {
                continue;
            }

            let key = normalize_name_key(&name);
            let score = if !key.is_empty() && key == desc_key {
                100
            } else if !key.is_empty() && key == stem_key {
                95
            } else if lower == desc_name {
                90
            } else if lower == stem {
                85
            } else if !desc_key.is_empty() && key.contains(&desc_key) {
                70
            } else if !stem_key.is_empty() && key.contains(&stem_key) {
                65
            } else if lower.contains(&desc_name) {
                60
            } else if lower.contains(&stem) {
                55
            } else if !desc_key.is_empty() && desc_key.contains(&key) {
                45
            } else if !stem_key.is_empty() && stem_key.contains(&key) {
                40
            } else {
                0
            };

            if score > 0 {
                match best {
                    Some((_, best_score)) if best_score >= score => {}
                    _ => best = Some((next, score)),
                }
            }
        }

        if let Some((component, _)) = best {
            Ok(component)
        } else {
            Err(PluginError::LoadFailed(format!(
                "AudioUnit component not found for '{}'",
                descriptor_name
            )))
        }
    }

    pub struct AudioUnitInstance {
        id: Uuid,
        descriptor: PluginDescriptor,
        unit: AudioUnit,
        is_active: bool,
        sample_rate: f64,
        max_buffer_size: usize,
        sample_time: f64,
        input_l: *const f32,
        input_r: *const f32,
        input_frames: usize,
        editor_window: Option<AuEditorWindow>,
    }

    // SAFETY: this instance is transferred to and used on the audio thread.
    // Raw pointers reference host buffers only during `process()` and are
    // cleared before returning, with no concurrent cross-thread access.
    unsafe impl Send for AudioUnitInstance {}

    impl AudioUnitInstance {
        pub fn load(descriptor: PluginDescriptor) -> Result<Self, PluginError> {
            let stem = descriptor
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&descriptor.name);
            let component = descriptor
                .unique_id
                .as_deref()
                .and_then(find_component_by_unique_id)
                .or_else(|| find_component_by_name_hint(stem, &descriptor.name).ok())
                .ok_or_else(|| {
                    PluginError::LoadFailed(format!(
                        "AudioUnit component not found for '{}' (uid={})",
                        descriptor.name,
                        descriptor.unique_id.as_deref().unwrap_or("n/a")
                    ))
                })?;
            let mut unit: AudioUnit = std::ptr::null_mut();
            // SAFETY: valid component handle, out pointer to unit storage.
            osstatus_ok(
                unsafe { AudioComponentInstanceNew(component, &mut unit) },
                "AudioComponentInstanceNew",
            )?;

            Ok(Self {
                id: Uuid::new_v4(),
                descriptor,
                unit,
                is_active: false,
                sample_rate: 44_100.0,
                max_buffer_size: 512,
                sample_time: 0.0,
                input_l: std::ptr::null(),
                input_r: std::ptr::null(),
                input_frames: 0,
                editor_window: None,
            })
        }

        fn stream_format(sample_rate: f64) -> AudioStreamBasicDescription {
            AudioStreamBasicDescription {
                m_sample_rate: sample_rate,
                m_format_id: K_AUDIO_FORMAT_LINEAR_PCM,
                m_format_flags: K_AUDIO_FORMAT_FLAG_IS_FLOAT
                    | K_AUDIO_FORMAT_FLAG_IS_PACKED
                    | K_AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED,
                m_bytes_per_packet: 4,
                m_frames_per_packet: 1,
                m_bytes_per_frame: 4,
                m_channels_per_frame: 1,
                m_bits_per_channel: 32,
                m_reserved: 0,
            }
        }

        unsafe extern "C" fn render_input_callback(
            in_ref_con: *mut c_void,
            _io_action_flags: *mut u32,
            _in_time_stamp: *const AudioTimeStamp,
            _in_bus_number: u32,
            in_number_frames: u32,
            io_data: *mut AudioBufferList,
        ) -> OSStatus {
            if in_ref_con.is_null() || io_data.is_null() {
                return NO_ERR;
            }
            // SAFETY: refcon is set to self pointer during activate and remains valid while active.
            let this = unsafe { &mut *(in_ref_con as *mut AudioUnitInstance) };
            let frames = usize::min(in_number_frames as usize, this.input_frames);
            // SAFETY: AU requests a non-interleaved AudioBufferList with at least 1 buffer for callback.
            let list = unsafe { &mut *(io_data as *mut AudioBufferListStereo) };
            let input_l = if !this.input_l.is_null() && frames > 0 {
                // SAFETY: input pointers point to current process() input buffers.
                unsafe { std::slice::from_raw_parts(this.input_l, frames) }
            } else {
                &[]
            };
            let input_r = if !this.input_r.is_null() && frames > 0 {
                // SAFETY: input pointers point to current process() input buffers.
                unsafe { std::slice::from_raw_parts(this.input_r, frames) }
            } else {
                &[]
            };

            for ch in 0..usize::min(list.m_number_buffers as usize, 2) {
                let buf = &mut list.m_buffers[ch];
                if buf.m_data.is_null() {
                    continue;
                }
                // SAFETY: mData points to AU-provided writable buffer of at least mDataByteSize bytes.
                let out = unsafe { std::slice::from_raw_parts_mut(buf.m_data as *mut f32, frames) };
                if ch == 0 {
                    if input_l.len() == frames {
                        out.copy_from_slice(input_l);
                    } else {
                        out.fill(0.0);
                    }
                } else if input_r.len() == frames {
                    out.copy_from_slice(input_r);
                } else if input_l.len() == frames {
                    out.copy_from_slice(input_l);
                } else {
                    out.fill(0.0);
                }
            }
            NO_ERR
        }
    }

    impl Drop for AudioUnitInstance {
        fn drop(&mut self) {
            let _ = self.close_editor();
            if !self.unit.is_null() {
                // SAFETY: valid AudioUnit instance owned by this object.
                let _ = unsafe { AudioUnitUninitialize(self.unit) };
                // SAFETY: valid AudioUnit instance owned by this object.
                let _ = unsafe { AudioComponentInstanceDispose(self.unit) };
                self.unit = std::ptr::null_mut();
            }
        }
    }

    impl PluginInstance for AudioUnitInstance {
        fn id(&self) -> Uuid {
            self.id
        }

        fn descriptor(&self) -> &PluginDescriptor {
            &self.descriptor
        }

        fn activate(
            &mut self,
            sample_rate: f64,
            max_buffer_size: usize,
        ) -> Result<(), PluginError> {
            self.sample_rate = sample_rate;
            self.max_buffer_size = max_buffer_size.max(1);
            let format = Self::stream_format(sample_rate);

            // SAFETY: unit is a valid AudioUnit instance.
            osstatus_ok(
                unsafe {
                    AudioUnitSetProperty(
                        self.unit,
                        K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
                        K_AUDIO_UNIT_SCOPE_INPUT,
                        0,
                        (&format as *const AudioStreamBasicDescription).cast(),
                        usize_to_u32_saturating(size_of::<AudioStreamBasicDescription>()),
                    )
                },
                "AudioUnitSetProperty(stream_format/input)",
            )?;
            // SAFETY: unit is a valid AudioUnit instance.
            osstatus_ok(
                unsafe {
                    AudioUnitSetProperty(
                        self.unit,
                        K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
                        K_AUDIO_UNIT_SCOPE_OUTPUT,
                        0,
                        (&format as *const AudioStreamBasicDescription).cast(),
                        usize_to_u32_saturating(size_of::<AudioStreamBasicDescription>()),
                    )
                },
                "AudioUnitSetProperty(stream_format/output)",
            )?;

            let cb = AURenderCallbackStruct {
                input_proc: Some(Self::render_input_callback),
                input_proc_ref_con: (self as *mut AudioUnitInstance).cast(),
            };
            // SAFETY: callback struct points to valid static callback and self ref.
            osstatus_ok(
                unsafe {
                    AudioUnitSetProperty(
                        self.unit,
                        K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK,
                        K_AUDIO_UNIT_SCOPE_INPUT,
                        0,
                        (&cb as *const AURenderCallbackStruct).cast(),
                        usize_to_u32_saturating(size_of::<AURenderCallbackStruct>()),
                    )
                },
                "AudioUnitSetProperty(render_callback)",
            )?;

            // SAFETY: initialize configured unit once per activation cycle.
            osstatus_ok(
                unsafe { AudioUnitInitialize(self.unit) },
                "AudioUnitInitialize",
            )?;
            self.is_active = true;
            Ok(())
        }

        fn deactivate(&mut self) -> Result<(), PluginError> {
            if self.is_active {
                // SAFETY: valid initialized unit.
                osstatus_ok(
                    unsafe { AudioUnitUninitialize(self.unit) },
                    "AudioUnitUninitialize",
                )?;
                self.is_active = false;
            }
            Ok(())
        }

        fn process(
            &mut self,
            inputs: &[&[f32]],
            outputs: &mut [&mut [f32]],
            num_frames: usize,
            midi_events: &[MidiEvent],
        ) -> Result<(), PluginError> {
            if !self.is_active || self.unit.is_null() {
                for out in outputs {
                    out.fill(0.0);
                }
                return Ok(());
            }
            let mut frames = num_frames.min(self.max_buffer_size);
            if let Some(ch) = outputs.first() {
                frames = frames.min(ch.len());
            }
            if let Some(ch) = outputs.get(1) {
                frames = frames.min(ch.len());
            }
            if frames == 0 {
                for out in outputs {
                    out.fill(0.0);
                }
                return Ok(());
            }
            self.input_l = inputs
                .first()
                .map(|c| c.as_ptr())
                .unwrap_or(std::ptr::null());
            self.input_r = inputs
                .get(1)
                .map(|c| c.as_ptr())
                .unwrap_or(std::ptr::null());
            self.input_frames = frames;

            // ── AU MIDI Dispatch ──────────────────────────────────────────────
            // For instrument-type AudioUnits (kAudioUnitType_MusicDevice), MIDI
            // events must be forwarded via MusicDeviceMIDIEvent() before calling
            // AudioUnitRender(). Without this, AU instruments never receive
            // Note On/Off events and produce no sound.
            //
            // For effect-type AUs (kAudioUnitType_Effect), MusicDeviceMIDIEvent
            // returns an error which we silently ignore — effects don't process
            // MIDI, and the call is harmless.
            if !midi_events.is_empty() && !self.unit.is_null() {
                for ev in midi_events {
                    let status = ev.data[0] as u32;
                    let data1 = ev.data[1] as u32;
                    let data2 = ev.data[2] as u32;
                    let offset = u32::try_from(ev.sample_offset.max(0)).unwrap_or(0);
                    // SAFETY: unit is valid and initialized; MIDI data is bounded.
                    let _ =
                        unsafe { MusicDeviceMIDIEvent(self.unit, status, data1, data2, offset) };
                }
            }

            let mut out_l_ptr = outputs
                .first_mut()
                .map(|c| c.as_mut_ptr())
                .unwrap_or(std::ptr::null_mut());
            let mut out_r_ptr = outputs
                .get_mut(1)
                .map(|c| c.as_mut_ptr())
                .unwrap_or(std::ptr::null_mut());

            let mut abl = AudioBufferListStereo {
                m_number_buffers: 2,
                m_buffers: [
                    AudioBuffer {
                        m_number_channels: 1,
                        m_data_byte_size: usize_to_u32_saturating(
                            frames.saturating_mul(size_of::<f32>()),
                        ),
                        m_data: out_l_ptr.cast(),
                    },
                    AudioBuffer {
                        m_number_channels: 1,
                        m_data_byte_size: usize_to_u32_saturating(
                            frames.saturating_mul(size_of::<f32>()),
                        ),
                        m_data: out_r_ptr.cast(),
                    },
                ],
            };

            let mut ts: AudioTimeStamp = unsafe { zeroed() };
            ts.m_sample_time = self.sample_time;
            ts.m_flags = K_AUDIO_TIME_STAMP_SAMPLE_TIME_VALID;
            self.sample_time += frames as f64;
            let mut flags: u32 = 0;
            // SAFETY: unit initialized; buffer list points to host output slices.
            let status = unsafe {
                AudioUnitRender(
                    self.unit,
                    &mut flags,
                    &ts,
                    0,
                    usize_to_u32_saturating(frames),
                    (&mut abl as *mut AudioBufferListStereo).cast(),
                )
            };
            self.input_l = std::ptr::null();
            self.input_r = std::ptr::null();
            self.input_frames = 0;

            if status != NO_ERR {
                return Err(PluginError::ProcessError(format!(
                    "AudioUnitRender failed with OSStatus {status}"
                )));
            }

            // If host requested more frames than processed, zero tail.
            if frames < num_frames {
                if let Some(ch) = outputs.first_mut() {
                    let tail_end = num_frames.min(ch.len());
                    ch[frames..tail_end].fill(0.0);
                }
                if let Some(ch) = outputs.get_mut(1) {
                    let tail_end = num_frames.min(ch.len());
                    ch[frames..tail_end].fill(0.0);
                }
            }
            if outputs.len() > 2 {
                for out in outputs.iter_mut().skip(2) {
                    out.fill(0.0);
                }
            }

            // Prevent unused-mut warnings on pointer locals when channel missing.
            let _ = (&mut out_l_ptr, &mut out_r_ptr);
            Ok(())
        }

        fn latency_samples(&self) -> u32 {
            0
        }

        fn reset(&mut self) {
            self.sample_time = 0.0;
        }

        fn is_active(&self) -> bool {
            self.is_active
        }

        fn set_transport_context(&mut self, _ctx: TransportContext) {}

        fn open_editor(&mut self) -> Result<(), PluginError> {
            if self.editor_window.is_some() {
                return Ok(());
            }
            if !is_main_thread() {
                return Err(PluginError::InvalidState(
                    "AudioUnit editor must be opened on the main thread".to_string(),
                ));
            }
            if self.unit.is_null() {
                return Err(PluginError::InvalidState(
                    "AudioUnit instance is not initialized".to_string(),
                ));
            }

            let cocoa_view = create_cocoa_view_for_unit(self.unit)?;
            if cocoa_view == nil {
                return Err(PluginError::UnsupportedFormat(
                    "AudioUnit returned an empty Cocoa UI view".to_string(),
                ));
            }

            // SAFETY: AppKit calls are guarded by main-thread check above.
            unsafe {
                let app = NSApp();
                app.setActivationPolicy_(NSApplicationActivationPolicyRegular);

                let mut preferred_frame: NSRect = cocoa_view_frame(cocoa_view);
                if preferred_frame.size.width < 420.0 {
                    preferred_frame.size.width = 960.0;
                }
                if preferred_frame.size.height < 260.0 {
                    preferred_frame.size.height = 640.0;
                }

                let window = NSWindow::alloc(nil).initWithContentRect_styleMask_backing_defer_(
                    NSRect::new(
                        NSPoint::new(0.0, 0.0),
                        NSSize::new(preferred_frame.size.width, preferred_frame.size.height),
                    ),
                    NSWindowStyleMask::NSTitledWindowMask
                        | NSWindowStyleMask::NSClosableWindowMask
                        | NSWindowStyleMask::NSMiniaturizableWindowMask
                        | NSWindowStyleMask::NSResizableWindowMask,
                    NSBackingStoreType::NSBackingStoreBuffered,
                    NO,
                );
                if window == nil {
                    return Err(PluginError::InvalidState(
                        "Failed to create AudioUnit editor window".to_string(),
                    ));
                }

                let title = NSString::alloc(nil).init_str(&self.descriptor.name);
                window.setTitle_(title);
                let content_view = window.contentView();
                if content_view == nil {
                    window.close();
                    return Err(PluginError::InvalidState(
                        "Failed to acquire AudioUnit editor content view".to_string(),
                    ));
                }

                let content_bounds: NSRect = content_view_bounds(content_view);
                set_view_frame(cocoa_view, content_bounds);
                set_view_autoresize_mask(cocoa_view, 18usize);
                add_subview(content_view, cocoa_view);
                window.center();
                window.makeKeyAndOrderFront_(nil);

                self.editor_window = Some(AuEditorWindow {
                    window: window as usize,
                });
            }

            Ok(())
        }

        fn close_editor(&mut self) -> Result<(), PluginError> {
            if !is_main_thread() {
                return Err(PluginError::InvalidState(
                    "AudioUnit editor must be closed on the main thread".to_string(),
                ));
            }
            let Some(editor) = self.editor_window.take() else {
                return Ok(());
            };
            // SAFETY: pointer was created by open_editor and is only consumed once here.
            // Closing the NSWindow tears down its view hierarchy; avoid messaging a potentially
            // stale plugin-owned NSView pointer directly.
            unsafe {
                let window = editor.window as id;
                if window != nil {
                    window.close();
                }
            }
            Ok(())
        }

        fn supports_editor(&self) -> bool {
            !self.unit.is_null() && has_cocoa_ui_property(self.unit)
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::AudioUnitInstance;

#[cfg(not(target_os = "macos"))]
pub struct AudioUnitInstance;

#[cfg(not(target_os = "macos"))]
impl AudioUnitInstance {
    pub fn load(_descriptor: PluginDescriptor) -> Result<Self, PluginError> {
        Err(PluginError::UnsupportedFormat(
            "AudioUnit runtime is only available on macOS".to_string(),
        ))
    }
}
