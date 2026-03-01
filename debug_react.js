const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const logs = [];

    page.on('console', msg => {
        logs.push(`[${msg.type()}] ${msg.text()}`);
        console.log(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', error => {
        logs.push(`[PAGE_ERROR] ${error.message}`);
        console.error(`[PAGE_ERROR] ${error.message}`);
    });

    try {
        await page.goto('http://localhost:5179', { waitUntil: 'networkidle2', timeout: 15000 });
    } catch (e) {
        console.error('Navigation error:', e.message);
    }

    // Wait a bit more for async module loads
    await new Promise(r => setTimeout(r, 5000));

    // Check if React root mounted
    const rootContent = await page.evaluate(() => {
        const root = document.getElementById('root');
        return root ? root.innerHTML.substring(0, 200) : 'ROOT NOT FOUND';
    });
    console.log('\n=== ROOT CONTENT ===');
    console.log(rootContent);

    // Check for any errors on __TEST_LOGS__
    const testLogs = await page.evaluate(() => window.__TEST_LOGS__ || []);
    if (testLogs.length > 0) {
        console.log('\n=== TEST LOGS ===');
        testLogs.forEach(l => console.log(l));
    }

    await browser.close();
})();
