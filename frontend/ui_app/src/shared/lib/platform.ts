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
