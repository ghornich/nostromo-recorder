// prevents browserify from requiring this module
const browserPuppeteerPath = './src/puppeteer/browser-puppeteer';

try {
    exports.BrowserPuppeteer = require(browserPuppeteerPath);
}
catch (error) {
    console.log('Ignored error: can\'t require BrowserPuppeteer');
}

exports.MESSAGES = require('./src/messages.cjs');
exports.COMMANDS = require('./src/commands');
