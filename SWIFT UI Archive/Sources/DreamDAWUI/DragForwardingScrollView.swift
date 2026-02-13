import AppKit
import DreamDAWModels

// MARK: - DragForwardingScrollView

/// NSScrollView subclass that accepts drag operations and forwards them
/// to its documentView. Standard NSScrollView's NSClipView intercepts drag
/// events, preventing documentView from receiving them.
public final class DragForwardingScrollView: NSScrollView {

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.browserItem, .fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // Forward all NSDraggingDestination methods to documentView

    public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if let docView = documentView as? NSDraggingDestination {
            return docView.draggingEntered?(sender) ?? []
        }
        return []
    }

    public override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if let docView = documentView as? NSDraggingDestination {
            return docView.draggingUpdated?(sender) ?? draggingEntered(sender)
        }
        return []
    }

    public override func draggingExited(_ sender: NSDraggingInfo?) {
        if let sender = sender, let docView = documentView as? NSDraggingDestination {
            docView.draggingExited?(sender)
        }
    }

    public override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let docView = documentView as? NSDraggingDestination {
            return docView.prepareForDragOperation?(sender) ?? true
        }
        return true
    }

    public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let docView = documentView as? NSDraggingDestination {
            return docView.performDragOperation?(sender) ?? false
        }
        return false
    }

    public override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        if let sender = sender, let docView = documentView as? NSDraggingDestination {
            docView.concludeDragOperation?(sender)
        }
    }
}
