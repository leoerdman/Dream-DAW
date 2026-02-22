import re

with open('frontend/ui_app/src/widgets/AssetBrowser/ui/AssetBrowserVirtualFileList.tsx', 'r') as f:
    content = f.read()

# 1. Replace imports and remove renderHighlightedMatch
content = re.sub(
    r"import \{ BrowserGlyph, TypeIcon \} from '\./AssetBrowserPrimitives';\n\nfunction renderHighlightedMatch.*?// ── Component ──────────────────────────────────────────",
    "import { BrowserGlyph } from './AssetBrowserPrimitives';\nimport { AssetListItemRow, PluginGroupHeaderRow, PluginGroupItemRow } from './AssetBrowserRows';\n\n// ── Component ──────────────────────────────────────────",
    content,
    flags=re.DOTALL
)

# 2. Replace visibleItems.map block
content = re.sub(
    r"\{visibleItems\.map\(\(item, vi\) => \{.*?return \(\n\s*<div\n\s*key=\{item\.id\}.*?</div>\n\s*\);\n\s*\}\)\}",
    """{visibleItems.map((item, vi) => (
                            <AssetListItemRow
                                key={item.id}
                                item={item}
                                absIdx={startIdx + vi}
                                ROW_HEIGHT={ROW_HEIGHT}
                                HEADER_HEIGHT={HEADER_HEIGHT}
                                isSelected={selectedItemId === item.id}
                                debouncedQuery={debouncedQuery}
                                showTypeColumn={showTypeColumn}
                                showSizeColumn={showSizeColumn}
                                audioDurationSecRef={audioDurationSecRef}
                                isPreviewPlayingRef={isPreviewPlayingRef}
                                itemRowRefs={itemRowRefs}
                                setSelectedItemId={setSelectedItemId}
                                syncPreviewForItem={syncPreviewForItem}
                                setContextMenu={setContextMenu}
                                navigateInto={navigateInto}
                                fileListRef={fileListRef}
                            />
                        ))}""",
    content,
    flags=re.DOTALL
)

# 3. Replace pluginGroupedRows.map block
content = re.sub(
    r"\{pluginGroupedRows\.map\(\(row\) => \{.*?if \(row\.kind === 'header'\) \{.*?return \(\n\s*<div.*?</div>\n\s*\);\n\s*\}\n*.*?return \(\n\s*<div.*?</div>\n\s*\);\n\s*\}\)\}",
    """{pluginGroupedRows.map((row) => {
                            if (row.kind === 'header') {
                                return <PluginGroupHeaderRow key={row.id} title={row.title} count={row.count} />;
                            }
                            return (
                                <PluginGroupItemRow
                                    key={row.id}
                                    item={row.item}
                                    ROW_HEIGHT={ROW_HEIGHT}
                                    isSelected={selectedItemId === row.item.id}
                                    debouncedQuery={debouncedQuery}
                                    showTypeColumn={showTypeColumn}
                                    showSizeColumn={showSizeColumn}
                                    audioDurationSecRef={audioDurationSecRef}
                                    isPreviewPlayingRef={isPreviewPlayingRef}
                                    itemRowRefs={itemRowRefs}
                                    setSelectedItemId={setSelectedItemId}
                                    syncPreviewForItem={syncPreviewForItem}
                                    setContextMenu={setContextMenu}
                                    fileListRef={fileListRef}
                                />
                            );
                        })}""",
    content,
    flags=re.DOTALL
)

with open('frontend/ui_app/src/widgets/AssetBrowser/ui/AssetBrowserVirtualFileList.tsx', 'w') as f:
    f.write(content)
