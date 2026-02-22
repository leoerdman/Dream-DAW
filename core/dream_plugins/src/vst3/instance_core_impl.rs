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
            // SAFETY: libc call has no arguments and is safe to query current thread role.
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

        let controller = self.controller_ptr as *mut IEditController;
        info!("[VST3-EDITOR] Step 1: Calling createView('editor')...");
        // SAFETY: controller pointer comes from COM bootstrap and remains valid while editor is opening.
        let view_raw = unsafe {
            ((*(*controller).vtbl).create_view)(controller, c"editor".as_ptr() as *const c_char)
        };
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

        info!("[VST3-EDITOR] Step 2: Calling isPlatformTypeSupported('NSView')...");
        // SAFETY: plug_view pointer is returned by createView above and is valid until released.
        let nsview_supported = unsafe {
            ((*(*plug_view).vtbl).is_platform_type_supported)(
                plug_view,
                c"NSView".as_ptr() as *const c_char,
            )
        } == K_RESULT_OK;
        info!(
            "[VST3-EDITOR] Step 2: isPlatformTypeSupported → {}",
            nsview_supported
        );
        if !nsview_supported {
            // SAFETY: plug_view is valid and needs explicit COM release on unsupported platform type.
            unsafe {
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
            }
            return Err(PluginError::UnsupportedFormat(
                "Plugin editor does not support NSView embedding on macOS".to_string(),
            ));
        }

        // SAFETY: AppKit/UI calls are guarded by main-thread check above and use valid Cocoa handles.
        unsafe {
            let app = NSApp();
            app.setActivationPolicy_(NSApplicationActivationPolicyRegular);

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
            info!("[VST3-EDITOR] Step 3: getSize → {}x{}", width, height);

            // BUG-E3 FIX: Check canResize() before adding the resize style mask.
            // Plugins like FabFilter Pro-Q break when resized if they don't support it.
            let can_resize = ((*(*plug_view).vtbl).can_resize)(plug_view) == K_RESULT_OK;
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
            let set_frame_result = ((*(*plug_view).vtbl).set_frame)(plug_view, frame_ptr);
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
        let already_cleaned = plugin_window_delegate_already_cleaned(window);

        if !already_cleaned {
            // CRITICAL: Mark the delegate as cleaned BEFORE doing VST3 cleanup.
            // When we call window.close() below, macOS fires windowWillClose:
            // on the delegate. If we don't mark it first, the delegate will try
            // to use the plug_view pointer that we're about to free → crash.
            mark_delegate_cleaned(window);

            // BUG-14 FIX: Per VST3 SDK, call setFrame(null) BEFORE dropping the
            // HostPlugFrame. Some plugins (UAD, Waves) cache the IPlugFrame pointer
            // and call resizeView during removed(), which would dereference freed memory.
            // SAFETY: plug_view is valid and accepts null frame during controlled teardown.
            unsafe {
                let _ = ((*(*plug_view).vtbl).set_frame)(plug_view, ptr::null_mut());
            }
            self.plug_frame.take();
            // SAFETY: plug_view is still alive and teardown order follows VST3 contract.
            unsafe {
                let _ = ((*(*plug_view).vtbl).removed)(plug_view);
                let _ = ((*(*plug_view).vtbl).release)(plug_view);
            }
        } else {
            // Delegate already cleaned up the plug_view, just drop our plug_frame
            self.plug_frame.take();
        }

        // SAFETY: window handle belongs to this editor instance and can be closed once.
        unsafe {
            window.close();
        }
        Ok(())
    }
}
