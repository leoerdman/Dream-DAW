import re

def fix_let_bindings(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    content = content.replace("let project_registry.clone(): &crate::state_managers::ProjectState = &*active_project_arc;", "let project_state: &crate::state_managers::ProjectState = &*active_project_arc;")
    with open(filepath, 'w') as f:
        f.write(content)

fix_let_bindings('apps/desktop_host/src/commands/sections/track_group_color.rs')

block_to_remove = """    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
"""

def remove_blocks(filepath, line_numbers):
    with open(filepath, 'r') as f:
        lines = f.readlines()
    
    # Sort in descending order to avoid line shift issues when deleting
    for start_line in sorted(line_numbers, reverse=True):
        idx = start_line - 1
        # verify the block matches
        block_text = "".join(lines[idx:idx+5])
        if "match project_registry.get_active_project()" in block_text:
            del lines[idx:idx+5]
            
    with open(filepath, 'w') as f:
        f.writelines(lines)

remove_blocks('apps/desktop_host/src/commands/sections/clip_mutators/helpers.rs', [209, 151, 71, 54, 37, 16])
remove_blocks('apps/desktop_host/src/commands/sections/clip_mutators/audio_state_commands.rs', [20, 5])

def replace_mismatches(filepath, pairs):
    with open(filepath, 'r') as f:
        content = f.read()
    for old, new in pairs:
        content = content.replace(old, new)
    with open(filepath, 'w') as f:
        f.write(content)

replace_mismatches('apps/desktop_host/src/commands/sections/clip_mutators/audio_state_commands.rs', [
    ("project_state.clone(),\n        clip_pool_state,\n        app,", "project_registry.clone(),\n        clip_pool_state,\n        app,"),
    ("project_state.clone(),\n        clip_pool_state,\n        handle,\n        app,", "project_registry.clone(),\n        clip_pool_state,\n        handle,\n        app,")
])

replace_mismatches('apps/desktop_host/src/commands/sections/clip_mutators/advanced_commands.rs', [
    ("project_state,\n        app,", "project_registry.clone(),\n        app,")
])

replace_mismatches('apps/desktop_host/src/commands/sections/clip_mutators/split_stems_commands.rs', [
    ("&project_registry,\n        &clip_pool_state,", "&project_state,\n        &clip_pool_state,")
])

print("Python fixes applied.")
