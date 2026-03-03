const fs = require('fs');
const path = require('path');
const dir = './frontend/ui_app/src/widgets/DeviceRack/ui';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
    const fullPath = path.join(dir, file);
    let content = fs.readFileSync(fullPath, 'utf8');
    let changed = false;

    // BUG-UI-027: Layout constraints overflow
    if (content.includes('preserveAspectRatio="none"')) {
        content = content.replace(/preserveAspectRatio="none"/g, 'preserveAspectRatio="xMidYMid slice"');
        changed = true;
    }

    // BUG-EC-100: SVG Hardware acceleration
    content = content.replace(/<svg\b([^>]+)\bstyle=\{\{([^}]+)\}\}/g, (match, before, styleContent) => {
        if (!styleContent.includes('transform')) {
            changed = true;
            return `<svg${before}style={{${styleContent}, willChange: 'transform', transform: 'translateZ(0)'}}`;
        }
        return match;
    });

    if (changed) {
        fs.writeFileSync(fullPath, content);
        console.log('Fixed', file);
    }
}
