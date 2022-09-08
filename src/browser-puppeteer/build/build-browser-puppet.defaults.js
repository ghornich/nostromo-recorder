(function () {
    const BrowserPuppet = require('../src/puppet/browser-puppet.js');
    const DOM_COMPLETE_STATE = 'complete';

    window.browserPuppet = new BrowserPuppet();

    function startPuppet() {
        window.browserPuppet.start();
    }

    if (document.readyState === DOM_COMPLETE_STATE) {
        startPuppet();
    }
    else {
        window.addEventListener('load', startPuppet);
    }
}());
