const fs = require('fs-extra');
const fsp = fs.promises;
const { exec } = require('child_process');
const puppeteer = require('puppeteer');

const chromiumBuilds = ['mac', 'linux', 'win32'];
const platformToChromium = {
    'mac': 'macos',
    'linux': 'linux',
    'win32': 'win'
}

const PACKAGE_NAME = 'nostromo-recorder';
const CHROMIUM_REVISION = 1022525;

(async function createExecutable() {
    try {
        if (fs.existsSync('./release')) {
            await fsp.rm('./release', { recursive: true });
        }
        await fsp.mkdir('./release/');
        await Promise.all(chromiumBuilds.map(platform => fsp.mkdir(`./release/${platform}`)));
        exec('npm run build', async (error, stdout) => {
            if (error) {
                throw error;
            }
            console.log(stdout);
            exec('pkg .', async (err, out) => {
                if (err) {
                    throw err;
                }
                console.log(out);
                if (!fs.existsSync('./chromium')) {
                    await fsp.mkdir('./chromium/');
                    await Promise.all(chromiumBuilds.map(platform => fsp.mkdir(`./chromium/${platform}`)));
                    await Promise.all(chromiumBuilds.map(platform => {
                        const browserFetcher = puppeteer.createBrowserFetcher({ path: `./chromium/${platform}`, platform: platform });
                        if (browserFetcher.canDownload(CHROMIUM_REVISION)) {
                            console.log(`Downloading Chromium for ${platform}`);
                            return browserFetcher.download(CHROMIUM_REVISION);
                        }
                    }));
                }
                console.log('Chromium builds downloaded.');
                console.log('Copying built executables.');
                await Promise.all(chromiumBuilds.map(async platform => {
                    const fileToMove = `./release/${PACKAGE_NAME}-${platformToChromium[platform]}${platform === 'win32' ? '.exe' : ''}`;
                    const fileDestination = `./release/${platform}/${PACKAGE_NAME}-${platform}${platform === 'win32' ? '.exe' : ''}`;
                    if (fs.existsSync(fileToMove)) {
                        return fsp.copyFile(fileToMove, fileDestination);
                    }
                }));
                console.log('Copied built executables.');
                console.log('Copying chromium folders.');
                await Promise.all(chromiumBuilds.map(async platform => {
                    const folderToMove = `./chromium/${platform}/${platform}-${CHROMIUM_REVISION}/chrome-${platform.replace(/[0-9]+/, '')}/`;
                    const folderDestination = `./release/${platform}/chromium/`;
                    if (fs.existsSync(folderToMove)) {
                        await fsp.mkdir(folderDestination);
                        return fs.copy(folderToMove, folderDestination);
                    }
                }));
                console.log('Copied chromium folders.');
                console.log('Release built successfully!');
            });
        });

    }
    catch (error) {
        console.log(error);
    }
}());