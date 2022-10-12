const { WebSocketServer } = require('ws');
const http = require('http');
const { ServerResponse } = http;
const fs = require('fs');
const fsp = fs.promises;
const JSONF = require('./jsonf/jsonf.cjs');
const path = require('path');
const { fileURLToPath } = require('url');
const puppeteer = require('puppeteer');
const childProcess = require('child_process');
const MESSAGES = require('./browser-puppeteer/src/messages.cjs');
const BrowserPuppeteer = require('./browser-puppeteer/src/puppeteer/browser-puppeteer.cjs');

/** @typedef {Object} Command */
/** @typedef {Object} RecorderApp */

/**
 * @memberOf RecorderServer
 * @type {Number}
 * @static
 * @constant
 */
const DEFAULT_RECORDER_APP_PORT = 7700;

/**
 * @callback FilterCallback
 * @param {Object} data
 * @param {Object} data.event - DOM event data (type, target, selector, $timestamp, $fullSelectorPath) - TODO typedef
 * @param {Command} data.command - Command generated from the event
 * @param {RecorderApp} data.recorderInstance - The current RecorderApp instance
 * @return {Boolean} Return false to prevent recording this event
 */

/**
 * @callback OnChangeCallback
 * @param {Object} data
 * @param {Object} data.event - TODO typedef
 * @param {RecorderApp} data.recorderInstance
 */

/**
 * @callback SelectorBecameVisibleCallback
 * @param {RecorderApp} recorderInstance - The current RecorderApp instance
 */

/**
 * @typedef {Object} OutputFormatter
 * @property {String} name - Display name
 * @property {String} [filename = RecorderApp.DEFAULT_OUTPUT_FILENAME]
 * @property {Function} fn - Formatter function, argument: Array&lt;Command&gt;, return: String
 */

/**
 * @typedef {Object} RecorderOptions
 * @property {Number} [recorderAppPort] See RecorderServer::DEFAULT_RECORDER_APP_PORT
 * @property {Number} [logLevel] - See Loggr.LEVELS
 *
 * @property {FilterCallback} [captureFilter]
 * @property {FilterCallback} [pressKeyFilter] - Special capture filter, only called for pressKey. <b>Default: capture Enter, Esc only</b>.
 *
 * @property {OnChangeCallback} [onChangeEvent]
 *
 * @property {Array<Object>} [onSelectorBecameVisible]
 * @property {String} [onSelectorBecameVisible[].selector] - CSS selector
 * @property {SelectorBecameVisibleCallback} [onSelectorBecameVisible[].listener]
 *
 * @property {Array<OutputFormatter>} outputFormatters - Custom output and download formatter(s)
 * @property {String} [selectedOutputFormatter] - Selected output formatter name
 *
 * @property {Array<String>} [mouseoverSelectors] - Detect mouseover events only for these selectors
 *
 * @property {Array<String>} [ignoredClasses] - DEPRECATED (use uniqueSelectorOptions) Ignored classnames
 * @property {Object} [uniqueSelectorOptions] import('../../modules/get-unique-selector').UniqueSelectorOptions
 *
 * @property {Array<Object>} [_mockMessages] - for testing only, do not use
 * @property {Boolean} [_preEnableRecording] - for testing only, do not use
 */

exports.RecorderServer = class RecorderServer {
    /**
    * @param {RecorderOptions} conf
    */
    constructor(conf) {
        this._conf = {
            recorderAppPort: DEFAULT_RECORDER_APP_PORT,
            onSelectorBecameVisible: [],
            mouseoverSelectors: [],
            // deprecated
            ignoredClasses: [],
            uniqueSelectorOptions: null,
            _mockMessages: [],
            ...conf,
        };

        // TODO assert conf
        // TODO check for configs not in default conf
        this._recorderAppServer = http.createServer(this._onRecRequest.bind(this));
        this._wsServer = new WebSocketServer({ server: this._recorderAppServer });
        this._puppeteer = new BrowserPuppeteer();

        /** @type {puppeteer.Browser} */
        this._browser = null;

        this._log = console;
    }

    async start() {
        this._wsServer.on('connection', () => console.log('recorder app connected'));
        this._recorderAppServer.listen(this._conf.recorderAppPort);
        // darwin - MacOS
        // win32 - Windows
        // linux - Linux
        let chromeExecutableName = '';
        switch (process.platform) {
            case 'darwin':
                chromeExecutableName = 'Chromium.app';
                break;
            case 'linux':
                chromeExecutableName = 'chrome';
                break;
            default:
                chromeExecutableName = 'chrome.exe';
                break;
        }
        this._browser = await puppeteer.launch({ headless: false, executablePath: `./chromium/${chromeExecutableName}` });
        this._puppeteer.start();

        this._browser.on('targetcreated', async (/** @type {import('puppeteer').Target} */ target) => {
            if (target.type() !== 'page') {
                return;
            }

            const newPage = (await target.page());
            newPage.on('domcontentloaded', () => {
                this.injectBrowserPuppeteer(newPage);
            });
        });

        const firstPage = (await this._browser.pages())[0];
        firstPage.on('domcontentloaded', () => {
            this.injectBrowserPuppeteer(firstPage);
        });

        // TODO platform-specific
        childProcess.exec(`start "" "http://localhost:${this._conf.recorderAppPort}"`, err => {
            if (err) {
                console.error(err);
            }
        });

        console.log('Recorder and target browsers launched!');

        const boundProxyMessage = this._proxyMessage.bind(this);
        this._puppeteer.on(MESSAGES.UPSTREAM.CAPTURED_EVENT, boundProxyMessage);
        this._puppeteer.on(MESSAGES.UPSTREAM.INSERT_ASSERTION, boundProxyMessage);
        this._puppeteer.on('puppetConnected', async () => {
            try {
                // TODO create & use setPuppetSettings?
                await this._puppeteer.setTransmitEvents(true);
                const selectors = (this._conf.onSelectorBecameVisible).map(data => data.selector);
                if (selectors.length > 0) {
                    await this._puppeteer.setSelectorBecameVisibleSelectors(selectors);
                }
                if (this._conf.mouseoverSelectors.length > 0) {
                    await this._puppeteer.sendMessage({
                        type: MESSAGES.DOWNSTREAM.SET_MOUSEOVER_SELECTORS,
                        selectors: this._conf.mouseoverSelectors,
                    });
                }
                if (this._conf.ignoredClasses.length > 0) {
                    await this._puppeteer.sendMessage({
                        type: MESSAGES.DOWNSTREAM.SET_IGNORED_CLASSES,
                        classes: this._conf.ignoredClasses,
                    });
                }
                if (this._conf.uniqueSelectorOptions) {
                    await this._puppeteer.sendMessage({
                        type: MESSAGES.DOWNSTREAM.SET_UNIQUE_SELECTOR_OPTIONS,
                        options: this._conf.uniqueSelectorOptions,
                    });
                }
            }
            catch (err) {
                this._log.error(err.stack || err.message);
            }
        });
    }

    async stop() {
        for (const page of await this._browser.pages()) {
            await page.close();
        }

        await this._browser.close();

        await new Promise(resolve => this._recorderAppServer.close(resolve));
    }

    _proxyMessage(data, rawData) {
        if (this._wsServer.clients.size === 1) {
            this._wsServer.clients.forEach(wsConn => wsConn.send(rawData));
        }
        else {
            console.warn(`_proxyMessage warning: invalid recording app connection count: ${this._wsServer.clients.size}`);
        }
    }

    /**
     *
     * @param {*} req
     * @param {ServerResponse} resp
     */
    async _onRecRequest(req, resp) {
        resp.setHeader('content-type', 'text/html');
        if (req.url === '/') {
            resp.end(
                (await fsp.readFile(path.resolve(__dirname, './ui/recorder-ui.html'), 'utf-8'))
                .replace('[[CONFIG]]', JSONF.stringify(this._conf).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')),
            );
        }
        else if (req.url === '/script.js') {
            resp.setHeader('content-type', 'application/json');
            resp.end(await fsp.readFile(path.resolve(__dirname, '../dist/recorder-app.dist.js'), 'utf-8'));
        }
        else if (req.url === '/style.css') {
            resp.setHeader('content-type', 'text/css');
            resp.end(await fsp.readFile(path.resolve(__dirname, './ui/app/style.css'), 'utf-8'));
        }
        else {
            resp.status = 404;
            resp.end('Not found');
        }
    }

    async injectBrowserPuppeteer(page) {
        const browserPuppeteer = await fsp.readFile(path.resolve(__dirname, './browser-puppeteer/dist/browser-puppet.defaults.js'), 'utf-8');
        await page.addScriptTag({ content: browserPuppeteer });
    }
};

exports.DEFAULT_RECORDER_APP_PORT = DEFAULT_RECORDER_APP_PORT;
