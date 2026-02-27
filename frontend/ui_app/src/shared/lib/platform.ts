export function isMacDesktopPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;

    const uaData = (navigator as Navigator & {
        userAgentData?: { platform?: string };
    }).userAgentData;
    const uaDataPlatform = uaData?.platform?.toLowerCase();
    if (uaDataPlatform) return uaDataPlatform === 'macos';

    const platform = (navigator.platform || '').toLowerCase();
    if (platform.startsWith('mac')) return true;

    const userAgent = (navigator.userAgent || '').toLowerCase();
    return userAgent.includes('mac') && !/(iphone|ipad|ipod)/i.test(userAgent);
}

export function isWindows(): boolean {
    if (typeof navigator === 'undefined') return false;
    const platform = (navigator.platform || '').toLowerCase();
    const userAgent = (navigator.userAgent || '').toLowerCase();
    return platform.startsWith('win') || userAgent.includes('windows');
}

export function isLinux(): boolean {
    if (typeof navigator === 'undefined') return false;
    const platform = (navigator.platform || '').toLowerCase();
    const userAgent = (navigator.userAgent || '').toLowerCase();
    return platform.startsWith('linux') || userAgent.includes('linux');
}

export function isIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    const platform = (navigator.platform || '').toLowerCase();
    const userAgent = (navigator.userAgent || '').toLowerCase();
    return platform.startsWith('iphone') || platform.startsWith('ipad') || platform.startsWith('ipod') ||
        /(iphone|ipad|ipod)/i.test(userAgent) ||
        // iPad on iOS 13+ detection
        (platform === 'macintel' && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = (navigator.userAgent || '').toLowerCase();
    return userAgent.includes('android');
}
