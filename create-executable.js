const fs = require('fs-extra');
const fsp = fs.promises;
const { exec } = require('child_process');
const puppeteer = require('puppeteer');
const archiver = require('archiver');

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
        if (!await fsp.access('./release', fs.constants.F_OK)) {
            console.log('Removing existing release directory.');
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
                if (await fsp.access('./chromium', fs.constants.F_OK)) {
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
                    return fsp.copyFile(fileToMove, fileDestination);
                }));
                console.log('Copied built executables.');
                console.log('Copying chromium folders.');
                await Promise.all(chromiumBuilds.map(async platform => {
                    const folderToMove = `./chromium/${platform}/${platform}-${CHROMIUM_REVISION}/chrome-${platform.replace(/[0-9]+/, '')}/`;
                    const folderDestination = `./release/${platform}/chromium/`;
                    await fsp.mkdir(folderDestination);
                    return fs.copy(folderToMove, folderDestination);
                }));
                console.log('Copied chromium folders.');
                console.log('Adding folders to archives.');
                await Promise.all(chromiumBuilds.map(async platform => {
                    const folderToZip = `./release/${platform}`;
                    return zipDirectory(folderToZip, folderToZip + '.zip');
                }));
                console.log('Release built successfully!');
            });
        });

    }
    catch (error) {
        console.log(error);
    }
}());


/**
 * @param {String} sourceDir: /some/folder/to/compress
 * @param {String} outPath: /path/to/created.zip
 * @returns {Promise}
 */
 function zipDirectory(sourceDir, outPath) {
    const archive = archiver('zip', { zlib: { level: 9 }});
    const stream = fs.createWriteStream(outPath);
  
    return new Promise((resolve, reject) => {
      archive
        .directory(sourceDir, false)
        .on('error', err => reject(err))
        .pipe(stream)
      ;
  
      stream.on('close', () => resolve());
      archive.finalize();
    });
  }