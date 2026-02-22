import sys, re

with open('apps/desktop_host/src/commands/sections/project_management.rs', 'r') as f:
    text = f.read()

# The split point is right before:
# /// Imports an Ableton `.als` project and installs it as the active session.
# #[tauri::command]
split_marker = "/// Imports an Ableton `.als` project and installs it as the active session."
split_idx = text.find(split_marker)

if split_idx == -1:
    print("Could not find split point")
    sys.exit(1)

als_code = text[:split_idx]
remaining_code = text[split_idx:]

# Prepare the imports for project_import.rs
als_code = als_code.replace("use dream_importers::ableton::", "use crate::ableton::")

# We need to prepend missing imports
missing_imports = """use std::path::{Path, PathBuf};
use uuid::Uuid;
use dream_models::project::{Project, Track, TrackType, SamplerConfig};

"""

# Remove `use std::path::{Path, PathBuf};` from als_code if it exists, to prevent duplicate
als_code = als_code.replace("use std::path::{Path, PathBuf};\n", "")

als_code = missing_imports + als_code

# Make the main entry functions pub
als_code = als_code.replace("fn import_als_project_with_target_sample_rate(", "pub fn import_als_project_with_target_sample_rate(")
als_code = als_code.replace("fn import_als_project(", "pub fn import_als_project(")

# Replace #[cfg(test)]mod project_management_als_import_tests; with empty string (we will move the tests later)
als_code = re.sub(r"#\[cfg\(test\)\]\nmod project_management_als_import_tests;\n", "", als_code)

with open('core/dream_importers/src/ableton/project_import.rs', 'w') as f:
    f.write(als_code)

# Add pub mod project_import to ableton/mod.rs
with open('core/dream_importers/src/ableton/mod.rs', 'r') as f:
    mod_text = f.read()

if "pub mod project_import;" not in mod_text:
    mod_text = mod_text.replace("pub mod parser;", "pub mod parser;\npub mod project_import;")
    with open('core/dream_importers/src/ableton/mod.rs', 'w') as f:
        f.write(mod_text)

# Write back to project_management.rs
new_pm_code = remaining_code
with open('apps/desktop_host/src/commands/sections/project_management.rs', 'w') as f:
    f.write(new_pm_code)

# Let's also move the test file
import os, shutil
if os.path.exists('apps/desktop_host/src/commands/sections/project_management_als_import_tests.rs'):
    shutil.move('apps/desktop_host/src/commands/sections/project_management_als_import_tests.rs', 'core/dream_importers/src/ableton/project_import_tests.rs')
    # and add #[cfg(test)] \n mod project_import_tests; to project_import.rs
    with open('core/dream_importers/src/ableton/project_import.rs', 'a') as f:
        f.write("\n#[cfg(test)]\nmod project_import_tests;\n")

print("Python extraction script executed.")
