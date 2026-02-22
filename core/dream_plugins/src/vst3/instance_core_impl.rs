use super::*;

impl Vst3Instance {
    #[cfg(target_os = "macos")]
    pub(super) fn open_editor_macos(&mut self) -> Result<(), PluginError> {
        // BUG-22+E5 FIX: AppKit/Cocoa APIs MUST be called from the main thread.
        // BUG-E5 FIX: Use pthread_main_np() instead of thread name check.
        // Thread names are not guaranteed to be "main" on macOS.
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn pthread_main_np() -> i32;
            }
            let is_main = unsafe { pthread_main_np() } != 0;
            debug_assert!(
                is_main || cfg!(test),
                "open_editor_macos must be called from the main thread"
            );
        }
        if self.editor_window.is_some() {
            return Ok(());
        }
        if self.controller_ptr == 0 {
            return Err(PluginError::UnsupportedFormat(
                "VST3 edit controller is unavailable for this plugin".to_string(),
            ));
        }

        info!(
            "[VST3-EDITOR] ── open_editor_macos START for '{}' ──",
            self.descriptor.name
        );
        info!(
            "[VST3-EDITOR] controller_ptr={:#x}, component_ptr={:#x}, processor_ptr={:#x}",
            self.controller_ptr, self.component_ptr, self.processor_ptr
        );
        info!(
            "[VST3-EDITOR] host_initialized={}, com_initialized={}",
            self.host_initialized, self.com_initialized
        );

        // ── File-based step-by-step diagnostics ──
        // Each step writes to diag file with flush, so the last written line
        // pinpoints exactly where the crash occurs.
        macro_rules! diag_step {
            ($($arg:tt)*) => {{
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true)
                    .open("/tmp/dream-daw-diag.txt") {
                    let _ = writeln!(f, $($arg)*);
                    let _ = f.flush();
                }
            }}
        }

        diag_step!(
            "[open_editor:{}] Step 1: createView about to call, controller={:#x}",
            self.descriptor.name,
            self.controller_ptr
        );

        let controller = self.controller_ptr as *mut IEditController;
        eprintln!(
            "[CRASH-DIAG] >>> createView about to call vtbl at {:p}",
            controller
        );
        info!("[VST3-EDITOR] Step 1: Calling createView('editor')...");
        let view_raw = unsafe {
            ((*(*controller).vtbl).create_view)(controller, c"editor".as_ptr() as *const c_char)
        };
        eprintln!("[CRASH-DIAG] <<< createView returned {:p}", view_raw);
        diag_step!(
            "[open_editor:{}] Step 1: createView returned {:p}",
            self.descriptor.name,
            view_raw
        );
        if view_raw.is_null() {
            return Err(PluginError::UnsupportedFormat(
                "Plugin did not provide an editor view".to_string(),
            ));
        }
        let plug_view = view_raw as *mut IPlugView;
        info!(
            "[VST3-EDITOR] Step 1: createView OK → plug_view={:p}",
            plug_view
        );

        eprintln!("[CRASH-DIAG] >>> isPlatformTypeSupported about to call");
        info!("[VST3-EDITOR] Step 2: Calling isPlatformTypeSupported('NSView')...");
        let nsview_supported = unsafe {
            ((*(*plug_view).vtbl).is_platform_type_supported)(
                plug_view,
                c"NSView".as_ptr() as *const c_char,
            )
        } == K_RESULT_OK;
        eprintln!(
            "[CRASH-DIAG] <<< isPlatformTypeSupported returned {}",
            nsview_supported
        );
        diag_step!(
            "[open_editor:{}] Step 2: isPlatformTypeSupported={}",
            self.descriptor.name,
            nsview_supported
        );
        info!(
            "[VST3-EDITOR] Step 2: isPlatformTypeSupported → {}",
            nsview_supported
        );
        if !nsview_supported {
            unsafe {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
            }
            return Err(PluginError::UnsupportedFormat(
                "Plugin editor does not support NSView embedding on macOS".to_string(),
            ));
        }

        unsafe {
            let app = NSApp();
            app.setActivationPolicy_(NSApplicationActivationPolicyRegular);

            eprintln!("[CRASH-DIAG] >>> getSize about to call");
            info!("[VST3-EDITOR] Step 3: Calling getSize...");
            let mut rect = ViewRect {
                left: 0,
                top: 0,
                right: 920,
                bottom: 640,
            };
            let _ = ((*(*plug_view).vtbl).get_size)(plug_view, &mut rect);
            let width = (rect.right - rect.left).max(420) as f64;
            let height = (rect.bottom - rect.top).max(300) as f64;
            eprintln!("[CRASH-DIAG] <<< getSize returned {}x{}", width, height);
            diag_step!(
                "[open_editor:{}] Step 3: getSize={}x{}",
                self.descriptor.name,
                width,
                height
            );
            info!("[VST3-EDITOR] Step 3: getSize → {}x{}", width, height);

            // BUG-E3 FIX: Check canResize() before adding the resize style mask.
            // Plugins like FabFilter Pro-Q break when resized if they don't support it.
            eprintln!("[CRASH-DIAG] >>> canResize about to call");
            let can_resize = ((*(*plug_view).vtbl).can_resize)(plug_view) == K_RESULT_OK;
            eprintln!("[CRASH-DIAG] <<< canResize returned {}", can_resize);
            info!("[VST3-EDITOR] Step 3b: canResize = {}", can_resize);

            info!("[VST3-EDITOR] Step 4: Creating NSWindow...");
            // BUG-E6 FIX: Use center() after init instead of hardcoded position.
            // Prevents all plugin windows from stacking on top of each other.
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
            let mut style = NSWindowStyleMask::NSTitledWindowMask
                | NSWindowStyleMask::NSClosableWindowMask
                | NSWindowStyleMask::NSMiniaturizableWindowMask;
            if can_resize {
                style |= NSWindowStyleMask::NSResizableWindowMask;
            }

            let window = NSWindow::alloc(nil).initWithContentRect_styleMask_backing_defer_(
                frame,
                style,
                NSBackingStoreType::NSBackingStoreBuffered,
                NO,
            );
            if window == nil {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                return Err(PluginError::InvalidState(
                    "Failed to allocate macOS editor window".to_string(),
                ));
            }

            // ENTERPRISE WINDOWING: Match Ableton/Bitwig behavior.
            // 1. NSWindowCollectionBehaviorTransient: Hides window from Mission Control (Exposé).
            // 2. NSWindowCollectionBehaviorIgnoresCycle: Excludes from Cmd+` cycle.
            use cocoa::appkit::NSWindowCollectionBehavior;
            window.setCollectionBehavior_(
                NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
            );

            diag_step!(
                "[open_editor:{}] Step 4: NSWindow created at {:p}",
                self.descriptor.name,
                window
            );
            info!("[VST3-EDITOR] Step 4: NSWindow created OK");

            // BUG-E2 FIX: Set the window title to the plugin name.
            // Previously untitled — confusing when multiple editors are open.
            use cocoa::foundation::NSString;
            let title = cocoa::foundation::NSString::alloc(nil).init_str(&self.descriptor.name);
            window.setTitle_(title);

            let content_view = window.contentView();
            if content_view == nil {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                window.close();
                return Err(PluginError::InvalidState(
                    "Failed to acquire editor content view".to_string(),
                ));
            }
            info!("[VST3-EDITOR] Step 5: contentView OK → {:p}", content_view);

            // ── CRITICAL: Enable layer-backed rendering for the content view ──
            // Modern VSTGUI (4.10+) and plugins like Serum2 use Metal/CoreAnimation
            // for GPU-accelerated rendering. This requires the parent NSView to be
            // layer-backed (wantsLayer = YES). Without this, the plugin's CALayer
            // subviews won't composite and the window shows a white/blank screen.
            unsafe extern "C" {
                fn sel_registerName(name: *const std::os::raw::c_char) -> *mut c_void;
            }
            let sel_set_wants_layer =
                sel_registerName(c"setWantsLayer:".as_ptr() as *const std::os::raw::c_char);
            // Cast objc_msgSend to the exact signature we need (non-variadic).
            // On ARM64, variadic vs non-variadic ABI differs — this typed cast
            // ensures correct register usage.
            type MsgSendBool = unsafe extern "C" fn(id, *mut c_void, i8);
            let send: MsgSendBool = {
                unsafe extern "C" {
                    fn objc_msgSend();
                }
                std::mem::transmute(objc_msgSend as *const ())
            };
            send(content_view, sel_set_wants_layer, 1); // YES = 1
            info!("[VST3-EDITOR] Step 5b: setWantsLayer:YES on contentView");

            // ── CRITICAL: Make the window visible BEFORE attached() ──
            // VSTGUI's CFrame creates an IPlatformFrame that depends on the
            // underlying NSView being in a displayable window with a valid
            // backing store. If the window isn't on-screen, the platform
            // frame pointer is NULL → Serum2 dereferences offset 0x60 → SIGSEGV.
            window.center();
            window.makeKeyAndOrderFront_(nil);
            diag_step!(
                "[open_editor:{}] Step 5c: window visible",
                self.descriptor.name
            );
            info!("[VST3-EDITOR] Step 5c: window centered + makeKeyAndOrderFront");

            // ── Wire IPlugFrame for editor resize notifications ──
            // CRITICAL: setFrame() MUST be called BEFORE attached() per VST3 SDK spec.
            // Plugins (e.g. Serum2) may access the IPlugFrame during attached() for
            // initial layout/resize. Without the frame set first, they dereference
            // a null pointer → SIGSEGV.
            info!("[VST3-EDITOR] Step 6: Creating HostPlugFrame and calling setFrame...");
            let mut frame_box = HostPlugFrame::new(window as usize);
            let frame_ptr = (&mut *frame_box as *mut HostPlugFrame).cast::<c_void>();
            info!(
                "[VST3-EDITOR] Step 6: HostPlugFrame at {:p}, vtbl at {:p}",
                frame_ptr,
                frame_box.vtable_ptr()
            );
            eprintln!(
                "[CRASH-DIAG] >>> setFrame about to call, frame_ptr={:p}, plug_view={:p}",
                frame_ptr, plug_view
            );
            let set_frame_result = ((*(*plug_view).vtbl).set_frame)(plug_view, frame_ptr);
            eprintln!("[CRASH-DIAG] <<< setFrame returned {}", set_frame_result);
            diag_step!(
                "[open_editor:{}] Step 6: setFrame returned {}",
                self.descriptor.name,
                set_frame_result
            );
            info!(
                "[VST3-EDITOR] Step 6: setFrame returned {}",
                set_frame_result
            );
            self.plug_frame = Some(frame_box);

            // ── CRITICAL: Create a dedicated child NSView for plugin embedding ──
            // Professional VST3 hosts (REAPER, Bitwig, Studio One) NEVER pass the
            // window's contentView directly to attached(). Instead, they create a
            // dedicated child NSView with exact plugin dimensions and proper layer
            // backing. VSTGUI's CFrame::open() creates an IPlatformFrame backed by
            // this view. If we pass contentView directly, the contentView may have
            // incompatible autoresizing behavior, conflicting subviews (from the
            // window chrome), or a frame that doesn't match the plugin's expected
            // dimensions — causing VSTGUI's internal init to fail → NULL dereference.
            let sel_alloc = sel_registerName(c"alloc".as_ptr() as *const std::os::raw::c_char);
            let sel_init_with_frame =
                sel_registerName(c"initWithFrame:".as_ptr() as *const std::os::raw::c_char);
            let sel_add_subview =
                sel_registerName(c"addSubview:".as_ptr() as *const std::os::raw::c_char);
            let sel_set_autoresizing =
                sel_registerName(c"setAutoresizingMask:".as_ptr() as *const std::os::raw::c_char);

            unsafe extern "C" {
                fn objc_getClass(name: *const std::os::raw::c_char) -> id;
                fn objc_msgSend();
            }

            let nsview_class = objc_getClass(c"NSView".as_ptr() as *const std::os::raw::c_char);

            // Allocate a new NSView
            type MsgSendId = unsafe extern "C" fn(id, *mut c_void) -> id;
            let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const ());
            let plugin_host_view = send_id(nsview_class, sel_alloc);

            // initWithFrame: with the plugin's requested size
            let plugin_frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
            type MsgSendInitFrame = unsafe extern "C" fn(id, *mut c_void, NSRect) -> id;
            let send_init: MsgSendInitFrame = std::mem::transmute(objc_msgSend as *const ());
            let plugin_host_view = send_init(plugin_host_view, sel_init_with_frame, plugin_frame);

            if plugin_host_view == nil {
                let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, ptr::null_mut());
                self.plug_frame.take();
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                window.close();
                return Err(PluginError::InvalidState(
                    "Failed to create plugin host NSView".to_string(),
                ));
            }

            // Enable layer-backing on the plugin host view
            let sel_set_wants_layer2 =
                sel_registerName(c"setWantsLayer:".as_ptr() as *const std::os::raw::c_char);
            // MsgSendBool already defined above
            let send_bool2: MsgSendBool = std::mem::transmute(objc_msgSend as *const ());
            send_bool2(plugin_host_view, sel_set_wants_layer2, 1);

            // Set autoresizing mask: width + height sizable (18 = NSViewWidthSizable | NSViewHeightSizable)
            type MsgSendULong = unsafe extern "C" fn(id, *mut c_void, u64);
            let send_ulong: MsgSendULong = std::mem::transmute(objc_msgSend as *const ());
            send_ulong(plugin_host_view, sel_set_autoresizing, 18); // NSViewWidthSizable | NSViewHeightSizable

            // Add the plugin host view as a subview of contentView
            type MsgSendVoidId = unsafe extern "C" fn(id, *mut c_void, id);
            let send_void_id: MsgSendVoidId = std::mem::transmute(objc_msgSend as *const ());
            send_void_id(content_view, sel_add_subview, plugin_host_view);

            info!(
                "[VST3-EDITOR] Step 6b: Created plugin host NSView {:p} ({}x{}), added to contentView {:p}",
                plugin_host_view, width, height, content_view
            );

            diag_step!(
                "[open_editor:{}] Step 6b: pluginHostView {:p} ({}x{})",
                self.descriptor.name,
                plugin_host_view,
                width,
                height
            );
            diag_step!(
                "[open_editor:{}] Step 7: attached() about to call",
                self.descriptor.name
            );
            eprintln!(
                "[CRASH-DIAG] >>> attached about to call, plugin_host_view={:p} (child of content_view={:p})",
                plugin_host_view, content_view
            );
            info!("[VST3-EDITOR] Step 7: Calling attached(pluginHostView, 'NSView')...");

            // Set IN_ATTACHED guard so resizeView callbacks during attached()
            // don't call onSize() back into the plugin (prevents SIGSEGV).
            set_editor_in_attached(true);
            let attached = ((*(*plug_view).vtbl).attached)(
                plug_view,
                plugin_host_view as *mut c_void,
                c"NSView".as_ptr() as *const c_char,
            );
            set_editor_in_attached(false);
            diag_step!(
                "[open_editor:{}] Step 7: attached returned {}",
                self.descriptor.name,
                attached
            );
            eprintln!("[CRASH-DIAG] <<< attached returned {}", attached);
            info!("[VST3-EDITOR] Step 7: attached returned {}", attached);
            if attached != K_RESULT_OK {
                // Clean up: unset frame before releasing view
                let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, ptr::null_mut());
                self.plug_frame.take();
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
                window.close();
                return Err(PluginError::ProcessError(format!(
                    "Plugin editor attach failed with code {attached}"
                )));
            }

            // Window was already centered + ordered front before attached().

            // ── CRITICAL: Notify plugin of its initial viewport size ──
            // After attached(), VSTGUI plugins need an explicit onSize() call
            // to trigger their initial layout pass. Without this, the CFrame
            // doesn't know its actual bounds and renders a white/blank screen.
            // Also ensure the content view's frame exactly matches the plugin's
            // requested dimensions (title bar can cause mismatches).
            // The NSWindow was created with initWithContentRect: which sets the
            // content area to our specified size, so the content view should
            // already have the correct bounds.

            // Call onSize with the actual ViewRect to trigger VSTGUI layout
            let mut size_rect = ViewRect {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };
            let on_size_result = ((*(*plug_view).vtbl).on_size)(plug_view, &mut size_rect);
            info!(
                "[VST3-EDITOR] Step 8b: onSize({}x{}) returned {}",
                width, height, on_size_result
            );

            // ── FEATURE-2 FIX: Re-query getSize() after attached() ──
            // Some plugins (e.g. Serum2) report different sizes before and after
            // attached(). Re-query and resize the window to match the actual
            // preferred dimensions. This gives consistent, nearly-square windows.
            let mut post_rect = ViewRect {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };
            let post_size_ok = ((*(*plug_view).vtbl).get_size)(plug_view, &mut post_rect);
            if post_size_ok == K_RESULT_OK {
                // Use screen dimensions as upper bound (no arbitrary cap).
                // Professional DAWs trust the plugin's reported size.
                let screen = NSScreen::mainScreen(nil);
                let screen_frame = NSScreen::visibleFrame(screen);
                let max_w = screen_frame.size.width.max(1920.0);
                let max_h = screen_frame.size.height.max(1080.0);
                let post_w = ((post_rect.right - post_rect.left).max(420) as f64).min(max_w);
                let post_h = ((post_rect.bottom - post_rect.top).max(300) as f64).min(max_h);
                if (post_w - width).abs() > 1.0 || (post_h - height).abs() > 1.0 {
                    info!(
                        "[VST3-EDITOR] Step 8c: post-attached getSize differs: {}x{} → {}x{}, resizing window",
                        width, height, post_w, post_h
                    );
                    let new_content_rect =
                        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(post_w, post_h));
                    window.setContentSize_(NSSize::new(post_w, post_h));
                    window.center();

                    // Update pluginHostView frame to match
                    type MsgSendSetFrame = unsafe extern "C" fn(id, *mut c_void, NSRect);
                    let sel_set_frame_fn = sel_registerName(c"setFrame:".as_ptr() as _);
                    let send_set_frame: MsgSendSetFrame =
                        std::mem::transmute(objc_msgSend as *const ());
                    send_set_frame(plugin_host_view, sel_set_frame_fn, new_content_rect);

                    // Notify plugin of new size
                    let mut new_size_rect = ViewRect {
                        left: 0,
                        top: 0,
                        right: post_w as i32,
                        bottom: post_h as i32,
                    };
                    let _ = ((*(*plug_view).vtbl).on_size)(plug_view, &mut new_size_rect);
                }
            }

            // ── Diagnostic: inspect NSView hierarchy after attached() ──
            // Write diagnostics directly to a file (Tauri captures stdout/stderr)
            {
                use std::io::Write;
                let mut diag_file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open("/tmp/dream-daw-diag.txt")
                    .ok();

                macro_rules! diag {
                    ($($arg:tt)*) => {
                        if let Some(ref mut f) = diag_file {
                            let _ = writeln!(f, $($arg)*);
                            let _ = f.flush();
                        }
                    }
                }

                diag!("=== EDITOR DIAG for '{}' ===", self.descriptor.name);
                diag!("attached() returned OK, onSize returned {}", on_size_result);

                type MsgSendId = unsafe extern "C" fn(id, *mut c_void) -> id;
                type MsgSendUsize = unsafe extern "C" fn(id, *mut c_void) -> usize;
                type MsgSendNSRect = unsafe extern "C" fn(id, *mut c_void) -> NSRect;
                type MsgSendBoolRet = unsafe extern "C" fn(id, *mut c_void) -> i8;
                let send_id: MsgSendId = std::mem::transmute(objc_msgSend as *const ());
                let send_usize: MsgSendUsize = std::mem::transmute(objc_msgSend as *const ());
                let send_bool: MsgSendBoolRet = std::mem::transmute(objc_msgSend as *const ());
                let send_rect: MsgSendNSRect = std::mem::transmute(objc_msgSend as *const ());

                let sel_subviews = sel_registerName(c"subviews".as_ptr() as _);
                let sel_count = sel_registerName(c"count".as_ptr() as _);
                let sel_object_at = sel_registerName(c"objectAtIndex:".as_ptr() as _);
                let sel_frame = sel_registerName(c"frame".as_ptr() as _);
                let sel_wants_layer = sel_registerName(c"wantsLayer".as_ptr() as _);
                let sel_is_hidden = sel_registerName(c"isHidden".as_ptr() as _);
                let sel_class_name = sel_registerName(c"className".as_ptr() as _);
                let sel_utf8 = sel_registerName(c"UTF8String".as_ptr() as _);

                let cv_frame = send_rect(content_view, sel_frame);
                let cv_wants_layer = send_bool(content_view, sel_wants_layer);

                diag!(
                    "contentView ptr={:p}, frame=({}, {}, {}, {}), wantsLayer={}",
                    content_view,
                    cv_frame.origin.x,
                    cv_frame.origin.y,
                    cv_frame.size.width,
                    cv_frame.size.height,
                    cv_wants_layer
                );

                let subviews_array = send_id(content_view, sel_subviews);
                let subview_count = send_usize(subviews_array, sel_count);
                diag!("contentView subview count: {}", subview_count);

                type MsgSendIdUsize = unsafe extern "C" fn(id, *mut c_void, usize) -> id;
                let send_id_usize: MsgSendIdUsize = std::mem::transmute(objc_msgSend as *const ());

                type MsgSendPtr =
                    unsafe extern "C" fn(id, *mut c_void) -> *const std::os::raw::c_char;
                let send_ptr: MsgSendPtr = std::mem::transmute(objc_msgSend as *const ());

                for i in 0..subview_count.min(5) {
                    let subview = send_id_usize(subviews_array, sel_object_at, i);
                    let sv_frame = send_rect(subview, sel_frame);
                    let sv_hidden = send_bool(subview, sel_is_hidden);
                    let sv_wants_layer = send_bool(subview, sel_wants_layer);
                    // Get class name
                    let class_ns_string = send_id(subview, sel_class_name);
                    let class_cstr = send_ptr(class_ns_string, sel_utf8);
                    let class_name = if !class_cstr.is_null() {
                        std::ffi::CStr::from_ptr(class_cstr).to_str().unwrap_or("?")
                    } else {
                        "null"
                    };
                    diag!(
                        "  subview[{}]: class={}, frame=({}, {}, {}, {}), hidden={}, wantsLayer={}",
                        i,
                        class_name,
                        sv_frame.origin.x,
                        sv_frame.origin.y,
                        sv_frame.size.width,
                        sv_frame.size.height,
                        sv_hidden,
                        sv_wants_layer
                    );
                }
                diag!("=== END DIAG ===");
            }

            // ── Install NSWindowDelegate for proper VST3 cleanup on close ──
            // When the user clicks the red close button, macOS calls
            // windowWillClose: on the delegate. We perform the full VST3
            // cleanup sequence there (setFrame(null) → removed() → release())
            // to prevent dangling pointers and crashes.
            install_plugin_window_delegate(window, plug_view);

            // Prevent NSWindow from auto-releasing on close, since our
            // delegate needs the window to remain valid during cleanup.
            type MsgSendSetBool = unsafe extern "C" fn(id, *mut c_void, i8);
            let sel_set_released = sel_registerName(c"setReleasedWhenClosed:".as_ptr() as _);
            let send: MsgSendSetBool = std::mem::transmute(objc_msgSend as *const ());
            send(window, sel_set_released, 0); // NO = 0

            window.makeKeyAndOrderFront_(nil);
            app.activateIgnoringOtherApps_(true);

            self.editor_window = Some(MacEditorWindow {
                window: window as usize,
                _content_view: content_view as usize,
                plug_view: plug_view as usize,
            });
            info!(
                "[VST3-EDITOR] ── open_editor_macos DONE for '{}' ──",
                self.descriptor.name
            );
        }

        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(super) fn close_editor_macos(&mut self) -> Result<(), PluginError> {
        let Some(window_state) = self.editor_window.take() else {
            return Ok(());
        };
        let plug_view = window_state.plug_view as *mut IPlugView;
        let window = window_state.window as id;

        // Check if the delegate already performed cleanup (user clicked red X).
        let already_cleaned = unsafe { plugin_window_delegate_already_cleaned(window) };

        if !already_cleaned {
            // CRITICAL: Mark the delegate as cleaned BEFORE doing VST3 cleanup.
            // When we call window.close() below, macOS fires windowWillClose:
            // on the delegate. If we don't mark it first, the delegate will try
            // to use the plug_view pointer that we're about to free → crash.
            unsafe {
                mark_delegate_cleaned(window);
            }

            // BUG-14 FIX: Per VST3 SDK, call setFrame(null) BEFORE dropping the
            // HostPlugFrame. Some plugins (UAD, Waves) cache the IPlugFrame pointer
            // and call resizeView during removed(), which would dereference freed memory.
            unsafe {
                let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, ptr::null_mut());
            }
            self.plug_frame.take();
            unsafe {
                let _ = ((*(*plug_view).vtbl).removed)(plug_view);
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
            }
        } else {
            // Delegate already cleaned up the plug_view, just drop our plug_frame
            self.plug_frame.take();
        }

        unsafe {
            window.close();
        }
        Ok(())
    }

    /// Loads a VST3 plugin from a bundle path.
    ///
    /// This performs:
    /// 1. Bundle resolution (finds the native binary).
    /// 2. Dynamic library loading via `libloading`.
    /// 3. Factory symbol lookup (`GetPluginFactory`).
    /// 4. Component instantiation via COM.
    ///
    /// # Errors
    /// Returns `PluginError::LoadFailed` if:
    /// - The bundle path doesn't contain a valid binary.
    /// - The dylib cannot be loaded.
    /// - The factory symbol is not found.
    pub fn load(descriptor: PluginDescriptor) -> Result<Self, PluginError> {
        if descriptor.format != PluginFormat::VST3 {
            return Err(PluginError::UnsupportedFormat(format!(
                "Expected VST3, got {}",
                descriptor.format
            )));
        }

        let bundle_path = &descriptor.path;
        let binary_path = resolve_vst3_binary(bundle_path).ok_or_else(|| {
            PluginError::LoadFailed(format!(
                "Cannot find native binary in VST3 bundle: {}",
                bundle_path.display()
            ))
        })?;

        info!(
            "[VST3] Loading binary: {} for plugin: {}",
            binary_path.display(),
            descriptor.name
        );

        // Load the native dynamic library
        let library = unsafe {
            libloading::Library::new(&binary_path).map_err(|e| {
                PluginError::LoadFailed(format!("Failed to load {}: {e}", binary_path.display()))
            })?
        };

        // BUG-C6 FIX: Call VST3 module entry function.
        // On macOS, VST3 modules expect bundleEntry(CFBundleRef) to be called after
        // loading the dylib. Some plugins (Steinberg, iZotope) initialize internal
        // state in bundleEntry and crash or produce incorrect output without it.
        //
        // SERUM2 FIX: We MUST pass a *real* CFBundleRef, not NULL.
        // VSTGUI-based plugins (Serum2, many others) use CFBundleCopyResourceURL()
        // on the bundle ref to locate GUI skin resources. If NULL is passed,
        // resources like "ButtonDialogNormal.png" are not found →
        // EResource C++ exception → crash on attached().
        #[cfg(target_os = "macos")]
        let _bundle_ref_guard: Option<CFBundleRefGuard> = {
            if let Ok(entry_fn) = unsafe {
                library.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"bundleEntry\0")
            } {
                let bundle_c_path = bundle_path.to_str().unwrap_or_default();
                let bundle_ref = if !bundle_c_path.is_empty() {
                    create_cf_bundle_ref(bundle_c_path)
                } else {
                    ptr::null_mut()
                };

                let result = unsafe { entry_fn(bundle_ref) };
                info!(
                    "[VST3] bundleEntry called for '{}': result={}, cfBundle={:p}",
                    descriptor.name, result, bundle_ref
                );
                // Keep the CFBundleRef alive for the entire lifetime of the plugin.
                // Plugins may use it at any point (e.g. during createView/attached).
                if !bundle_ref.is_null() {
                    Some(CFBundleRefGuard(bundle_ref))
                } else {
                    None
                }
            } else {
                info!(
                    "[VST3] No bundleEntry symbol found for '{}' (this is OK for most plugins)",
                    descriptor.name
                );
                None
            }
        };
        #[cfg(not(target_os = "macos"))]
        {
            if let Ok(init_fn) =
                unsafe { library.get::<unsafe extern "C" fn() -> bool>(b"InitDll\0") }
            {
                let result = unsafe { init_fn() };
                info!(
                    "[VST3] InitDll called for '{}': result={}",
                    descriptor.name, result
                );
            }
        }

        // Attempt real VST3 COM bootstrap.
        let (
            factory_ptr,
            component_ptr,
            processor_ptr,
            controller_ptr,
            processor_from_component_qi,
            controller_from_component_qi,
        ) = match init_vst3_com(&library) {
            Ok(ptrs) => ptrs,
            Err(err) => {
                info!(
                    "[VST3] COM bootstrap failed for '{}': {}. Using bridge/fallback path.",
                    descriptor.name, err
                );
                (0, 0, 0, 0, false, false)
            }
        };

        let process_fn = unsafe {
            library
                .get::<DreamDawProcessF32Fn>(b"dream_daw_process_f32\0")
                .ok()
                .map(|f| *f)
        };
        let open_editor_fn = unsafe {
            library
                .get::<DreamDawOpenEditorFn>(b"dream_daw_open_editor\0")
                .ok()
                .map(|f| *f)
        };
        let set_parameter_fn = unsafe {
            library
                .get::<DreamDawSetParameterFn>(b"dream_daw_set_parameter\0")
                .ok()
                .map(|f| *f)
        };

        info!(
            "[VST3] Successfully loaded: {} ({})",
            descriptor.name, descriptor.vendor
        );
        if process_fn.is_none() {
            info!(
                "[VST3] '{}' loaded without dream_daw_process_f32 symbol (pass-through fallback)",
                descriptor.name
            );
        }

        Ok(Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: Some(library),
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency: 0,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            scratch_aux_out_left: Vec::new(),
            scratch_aux_out_right: Vec::new(),
            process_fn,
            open_editor_fn,
            set_parameter_fn,
            factory_ptr,
            component_ptr,
            processor_ptr,
            controller_ptr,
            com_initialized: false,
            host_initialized: false,
            controller_from_component_qi,
            processor_from_component_qi,
            connection_point_component: 0,
            connection_point_controller: 0,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            _cf_bundle_ref: _bundle_ref_guard,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            // BUG-RT1 FIX: Pre-allocate with capacity to avoid audio-thread allocation.
            pending_param_changes: Vec::with_capacity(MAX_HOST_PARAM_CHANGES),
            parameter_values: HashMap::with_capacity(128),
            parameter_count_hint: 0,
            sidechain_bus_active: false,
        })
    }

    /// Creates a stub instance for testing (no real plugin loaded).
    #[cfg(test)]
    pub fn stub(descriptor: PluginDescriptor, latency: u32) -> Self {
        Self {
            id: Uuid::new_v4(),
            descriptor,
            _library: None,
            is_active: false,
            sample_rate: 44100.0,
            max_buffer_size: 0,
            latency,
            editor_open: false,
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            scratch_sidechain_left: Vec::new(),
            scratch_sidechain_right: Vec::new(),
            scratch_aux_out_left: Vec::new(),
            scratch_aux_out_right: Vec::new(),
            process_fn: None,
            open_editor_fn: None,
            set_parameter_fn: None,
            factory_ptr: 0,
            component_ptr: 0,
            processor_ptr: 0,
            controller_ptr: 0,
            com_initialized: false,
            host_initialized: false,
            controller_from_component_qi: false,
            processor_from_component_qi: false,
            connection_point_component: 0,
            connection_point_controller: 0,
            #[cfg(target_os = "macos")]
            editor_window: None,
            #[cfg(target_os = "macos")]
            _cf_bundle_ref: None,
            #[cfg(target_os = "macos")]
            plug_frame: None,
            audio_input_bus_count: 0,
            audio_output_bus_count: 0,
            transport_ctx: TransportContext::default(),
            // BUG-RT1 FIX: Pre-allocate with capacity to avoid audio-thread allocation.
            pending_param_changes: Vec::with_capacity(MAX_HOST_PARAM_CHANGES),
            parameter_values: HashMap::with_capacity(128),
            parameter_count_hint: 0,
            sidechain_bus_active: false,
        }
    }
}
