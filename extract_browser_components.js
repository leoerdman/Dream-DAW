const fs = require('fs');

const FILE_PATH = "/Users/leoerdman/Programming - MAIN FOLDER/Dream DAW/frontend/ui_app/src/widgets/AssetBrowser/AssetBrowser.tsx";
let content = fs.readFileSync(FILE_PATH, 'utf8');

// 1. Add definitions before "export const AssetBrowser ="
const componentsStr = `
const AssetSearchInput = React.memo(function AssetSearchInput({
    debouncedQuery,
    setDebouncedQuery,
    selectedCategoryId,
    setSelectedCategoryId,
    searchRef,
    handleBrowserKeyDown,
    fileListRef,
}: {
    debouncedQuery: string;
    setDebouncedQuery: (q: string) => void;
    selectedCategoryId: string;
    setSelectedCategoryId: (val: string) => void;
    searchRef: React.RefObject<HTMLInputElement>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
    fileListRef: React.RefObject<HTMLDivElement>;
}) {
    const [localQuery, setLocalQuery] = useState(debouncedQuery);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setLocalQuery(debouncedQuery);
    }, [debouncedQuery]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const nextQuery = e.target.value;
        setLocalQuery(nextQuery);

        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            setDebouncedQuery(nextQuery);
        }, 150);

        if (nextQuery.trim().length > 0 && selectedCategoryId !== 'all') {
            setSelectedCategoryId('all');
        }
    }, [setDebouncedQuery, selectedCategoryId, setSelectedCategoryId, fileListRef]);

    return (
        <input
            ref={searchRef}
            type="text"
            placeholder="Search… (⌘F)"
            value={localQuery}
            onChange={handleChange}
            onKeyDown={handleBrowserKeyDown}
            style={{
                width: '100%',
                padding: '6px 10px',
                background: 'var(--color-bg-input)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-xs)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
            }}
        />
    );
});

const VirtualFileList = React.memo(function VirtualFileList({
    items,
    selectedCategoryId,
    selectedItemId,
    setSelectedItemId,
    syncPreviewForItem,
    setContextMenu,
    navigateInto,
    showTypeColumn,
    showSizeColumn,
    debouncedQuery,
    audioDurationSecRef,
    itemRowRefs,
    fileListRef,
    handleBrowserKeyDown,
    pluginGroupedRows,
    scanLoading,
    scanError,
    columnMenuPos,
    setColumnMenuPos,
}: {
    items: BrowserItem[];
    selectedCategoryId: string;
    selectedItemId: string | null;
    setSelectedItemId: (id: string | null) => void;
    syncPreviewForItem: (item: BrowserItem | null) => void;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    navigateInto: (path: string) => void;
    showTypeColumn: boolean;
    showSizeColumn: boolean;
    debouncedQuery: string;
    audioDurationSecRef: React.MutableRefObject<Record<string, number>>;
    itemRowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
    fileListRef: React.RefObject<HTMLDivElement>;
    handleBrowserKeyDown: (e: React.KeyboardEvent) => void;
    pluginGroupedRows: any[];
    scanLoading: boolean;
    scanError: string | null;
    columnMenuPos: { x: number; y: number } | null;
    setColumnMenuPos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
}) {
    const ROW_HEIGHT = 28;
    const OVERSCAN = 8;
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(400);

    useEffect(() => {
        const el = fileListRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, [fileListRef]);

    const handleFileListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    }, []);

    const totalHeight = items.length * ROW_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);

    return (
`;

// Find the file list block
const fileListStartStr = "                    {/* File List */}\n                    <div\n                        ref={fileListRef}";
const startIndex = content.indexOf(fileListStartStr);
if (startIndex === -1) {
    console.error("Could not find file list start");
    process.exit(1);
}
// Find the end of the file list block
const noItemsFoundStr = "No items found\n                            </div>\n                        )}\n                    </div>";
const endIndex = content.indexOf(noItemsFoundStr, startIndex) + noItemsFoundStr.length;

let fileListBody = content.substring(startIndex, endIndex);

// Transform the body:
// 1. Rename searchQuery -> debouncedQuery
fileListBody = fileListBody.replace(/searchQuery\.trim\(\)/g, "debouncedQuery.trim()");
fileListBody = fileListBody.replace(/renderHighlightedMatch\(item\.name, searchQuery\)/g, "renderHighlightedMatch(item.name, debouncedQuery)");
// 2. Add padding to the virtual height
fileListBody = fileListBody.replace(/height: totalHeight, position/g, "height: totalHeight + 20, position");

const fullComponentDef = componentsStr + fileListBody + "\n    );\n});\n\n";

content = content.replace("export const AssetBrowser = () => {", fullComponentDef + "export const AssetBrowser = () => {");


// Now replace the usage in AssetBrowser
const usageReplace = `                    {/* File List */}
                    <VirtualFileList
                        items={items}
                        selectedCategoryId={selectedCategoryId}
                        selectedItemId={selectedItemId}
                        setSelectedItemId={setSelectedItemId}
                        syncPreviewForItem={syncPreviewForItem}
                        setContextMenu={setContextMenu}
                        navigateInto={navigateInto}
                        showTypeColumn={showTypeColumn}
                        showSizeColumn={showSizeColumn}
                        debouncedQuery={debouncedQuery}
                        audioDurationSecRef={audioDurationSecRef}
                        itemRowRefs={itemRowRefs}
                        fileListRef={fileListRef}
                        handleBrowserKeyDown={handleBrowserKeyDown}
                        pluginGroupedRows={pluginGroupedRows}
                        scanLoading={scanLoading}
                        scanError={scanError}
                        columnMenuPos={columnMenuPos}
                        setColumnMenuPos={setColumnMenuPos}
                    />`;

content = content.substring(0, startIndex + fullComponentDef.length) + usageReplace + content.substring(endIndex + fullComponentDef.length);

// Also replace the Search input
const searchStartStr = `<input
                    ref={searchRef}
                    type="text"
                    placeholder="Search… (⌘F)"
                    value={searchQuery}
                    onChange={e => {
                        const nextQuery = e.target.value;
                        setSearchQuery(nextQuery);
                        // Debounce the heavy filtering
                        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                        searchTimerRef.current = setTimeout(() => {
                            setDebouncedQuery(nextQuery);
                        }, 150);
                        if (nextQuery.trim().length > 0 && selectedCategoryId !== 'all') {
                            setSelectedCategoryId('all');
                        }
                        setScrollTop(0); if (fileListRef.current) fileListRef.current.scrollTop = 0;
                    }}
                    onKeyDown={handleBrowserKeyDown}
                    style={{
                        width: '100%',
                        padding: '6px 10px',
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--font-size-sm)',
                        fontFamily: 'var(--font-mono)',
                        outline: 'none',
                    }}
                />`;

const searchUsageStr = `<AssetSearchInput
                    debouncedQuery={debouncedQuery}
                    setDebouncedQuery={setDebouncedQuery}
                    selectedCategoryId={selectedCategoryId}
                    setSelectedCategoryId={setSelectedCategoryId}
                    searchRef={searchRef}
                    handleBrowserKeyDown={handleBrowserKeyDown}
                    fileListRef={fileListRef}
                />`;
content = content.replace(searchStartStr, searchUsageStr);

// Clean up state from AssetBrowser
content = content.replace("const [searchQuery, setSearchQuery] = useState('');\n    const [debouncedQuery, setDebouncedQuery] = useState('');\n    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);", "const [debouncedQuery, setDebouncedQuery] = useState('');");

// Fix handleBrowserKeyDown using searchQuery -> searchRef
content = content.replace("if (activeEl === searchRef.current && searchQuery.length > 0)", "if (activeEl === searchRef.current && searchRef.current.value.length > 0)");
content = content.replace("setSearchQuery('');\n                setDebouncedQuery('');\n                if (searchTimerRef.current) clearTimeout(searchTimerRef.current);\n                setScrollTop(0);\n                if (fileListRef.current) fileListRef.current.scrollTop = 0;", "setDebouncedQuery('');\n                if (fileListRef.current) fileListRef.current.value = '';\n                if (fileListRef.current) fileListRef.current.scrollTop = 0;");


// Remove old scroll logic
const scrollOldStr = `    // ── Virtual scrolling: only render items visible in viewport ──
    // ROW_HEIGHT must match the actual rendered row height (padding + content).
    const ROW_HEIGHT = 28;
    const OVERSCAN = 8; // extra rows above/below viewport for smooth scroll
    const [scrollTop, setScrollTop] = useState(0);
    const [containerHeight, setContainerHeight] = useState(400);

    // Compute visible window
    const totalHeight = items.length * ROW_HEIGHT;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
    const visibleItems = useMemo(() => items.slice(startIdx, endIdx), [items, startIdx, endIdx]);`;

content = content.replace(scrollOldStr, "");

const oldResizeStr = `    // Measure container height on mount and resize
    useEffect(() => {
        const el = fileListRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    const handleFileListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    }, []);`;

content = content.replace(oldResizeStr, "");

// Write back
fs.writeFileSync(FILE_PATH, content, 'utf8');
console.log("Successfully extracted components");
