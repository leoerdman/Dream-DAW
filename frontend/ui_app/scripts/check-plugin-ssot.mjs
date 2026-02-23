import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src');
const manifestPath = path.join(root, 'shared/config/pluginManifest.ts');
const internalPluginsPath = path.join(root, 'shared/lib/internalPlugins.ts');
const catalogPath = path.join(root, 'widgets/DeviceRack/model/deviceRackCatalog.ts');
const presetsPath = path.join(root, 'widgets/DeviceRack/model/deviceParamPresets.ts');

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

function extractManifestMap(text) {
    const map = new Map();
    const re = /id:\s*'([^']+)'[\s\S]*?effectType:\s*'([^']+)'/g;
    for (const match of text.matchAll(re)) {
        const id = match[1];
        if (id.startsWith('internal://')) map.set(id, match[2]);
    }
    return map;
}

function extractInternalIds(text) {
    const ids = new Set();
    const re = /id:\s*'([^']+)'/g;
    for (const match of text.matchAll(re)) {
        const id = match[1];
        if (id.startsWith('internal://')) ids.add(id);
    }
    return ids;
}

function extractCatalogMap(text) {
    const map = new Map();
    const re = /'([^']+)'\s*:\s*'([^']+)'/g;
    for (const match of text.matchAll(re)) {
        const id = match[1];
        if (id.startsWith('internal://')) map.set(id, match[2]);
    }
    return map;
}

function extractPresetEffectKeys(text) {
    const keys = new Set();
    const re = /^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\[/gm;
    for (const match of text.matchAll(re)) keys.add(match[2]);
    return keys;
}

const manifestText = read(manifestPath);
const internalText = read(internalPluginsPath);
const catalogText = read(catalogPath);
const presetsText = read(presetsPath);

const manifestMap = extractManifestMap(manifestText);
const internalIds = extractInternalIds(internalText);
const catalogMap = extractCatalogMap(catalogText);
const presetEffectKeys = extractPresetEffectKeys(presetsText);

const errors = [];

for (const id of internalIds) {
    if (!manifestMap.has(id)) {
        errors.push(`[manifest] missing internal plugin id: ${id}`);
    }
}
for (const id of manifestMap.keys()) {
    if (!internalIds.has(id)) {
        errors.push(`[internalPlugins] missing id from manifest: ${id}`);
    }
}
for (const [id, effectType] of manifestMap.entries()) {
    const catalogEffect = catalogMap.get(id);
    if (!catalogEffect) {
        errors.push(`[deviceRackCatalog] missing internal mapping for id: ${id}`);
        continue;
    }
    if (catalogEffect !== effectType) {
        errors.push(
            `[effectType mismatch] ${id}: manifest='${effectType}' catalog='${catalogEffect}'`,
        );
    }
}
for (const effectType of new Set(catalogMap.values())) {
    const skip = new Set(['vst', 'rack', 'sample_rack']);
    if (skip.has(effectType)) continue;
    if (!presetEffectKeys.has(effectType)) {
        errors.push(`[deviceParamPresets] missing preset list for effectType '${effectType}'`);
    }
}

if (errors.length > 0) {
    console.error('Plugin SSOT check failed:\n');
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
}

console.log('Plugin SSOT check passed.');
