'use strict';

const $ = require('jquery'); $.noConflict();
const MESSAGES = require('../messages.cjs');
const JSONF = require('../../../jsonf/jsonf.cjs');
const UniqueSelector = require('../../../get-unique-selector');
const debounce = require('lodash.debounce');
const Ws4ever = require('../../../ws4ever');
const defaults = require('lodash.defaults');
const BrowserPuppetCommands = require('./browser-puppet-commands.partial');
const log = require('loglevel');
const SelectorObserver = require('../../../selector-observer');

const INSERT_ASSERTION_DEBOUNCE = 500;

const DEFAULT_SERVER_URL = 'ws://localhost:47225';

exports = module.exports = BrowserPuppet;

/**
 * @class
 * @extends {BrowserPuppetCommands}
 * @param {Object} [opts]
 * @param {String} [opts.serverUrl=DEFAULT_SERVER_URL] - BrowserPuppeteer websocket server URL
 */
function BrowserPuppet(opts) {
    this._opts = defaults({}, opts, {
        serverUrl: DEFAULT_SERVER_URL,
    });

    assert(/^ws:\/\/.+/.test(this._opts.serverUrl), 'BrowserPuppet: missing or invalid serverUrl, expected "ws://..."');

    this._transmitEvents = false;
    this._isExecuting = false;
    this._isTerminating = false;

    this._wsConn = null;

    this.$ = $;

    this._uniqueSelector = new UniqueSelector();

    this._selectorObserver = null;
    this._mouseoverSelector = null;
    this._activeElementBeforeWindowBlur = null;

    this._puppetId = Math.floor(Math.random() * 10e12);
}

Object.assign(BrowserPuppet.prototype, BrowserPuppetCommands.prototype);

BrowserPuppet.prototype.start = function () {
    this._startWs();
    this._attachCaptureEventListeners();
    this._attachConsolePipe();
};

BrowserPuppet.prototype._startWs = function () {
    const self = this;

    // TODO use url lib instead of concat
    self._wsConn = new Ws4ever(self._opts.serverUrl + '?puppet-id=' + this._puppetId);
    self._wsConn.onmessage = function (e) {
        self._onMessage(e.data);
    };
    self._wsConn.onerror = function (err) {
        log.error(err);
    };
};

BrowserPuppet.prototype._sendMessage = function (rawData) {
    let data = rawData;

    if (typeof data === 'object') {
        data = JSONF.stringify(data);
    }

    this._wsConn.send(data);
};

BrowserPuppet.prototype._isJQueryElementsVisible = function ($els) {
    if ($els.length === 0) {
        return false;
    }
    if (!$els.is(':visible')) {
        return false;
    }

    for (let i = 0; i < $els.length; i++) {
        const el = $els[i];
        const rect = el.getBoundingClientRect();
        const elCenterX = rect.left + rect.width / 2;
        const elCenterY = rect.top + rect.height / 2;
        const elFromPoint = document.elementFromPoint(elCenterX, elCenterY);

        if (elFromPoint === el || el.contains(elFromPoint)) {
            return true;
        }
    }

    return false;
};

BrowserPuppet.prototype.isSelectorVisible = function (selector) {
    return this._isJQueryElementsVisible(this.$(selector));
};

BrowserPuppet.prototype._onMessage = async function (rawData) {
    if (this._isTerminating) {
        throw new Error('BrowserPuppet::_onMessage: cannot process message, puppet is terminating');
    }

    // no return
    let result;

    try {
        const data = JSONF.parse(rawData);

        switch (data.type) {
            case MESSAGES.DOWNSTREAM.EXEC_COMMAND:
            case MESSAGES.DOWNSTREAM.EXEC_FUNCTION:
                this._isExecuting = true;
                result = await this._onExecMessage(data);
                break;

            case MESSAGES.DOWNSTREAM.SET_SELECTOR_BECAME_VISIBLE_DATA:
                result = this.setOnSelectorBecameVisibleSelectors(data.selectors);
                break;

            case MESSAGES.DOWNSTREAM.SET_TRANSMIT_EVENTS:
                this.setTransmitEvents(data.value);
                break;

            case MESSAGES.DOWNSTREAM.CLEAR_PERSISTENT_DATA:
                this.clearPersistentData();
                break;

            case MESSAGES.DOWNSTREAM.SET_MOUSEOVER_SELECTORS:
                this._mouseoverSelector = data.selectors.join(', ');
                this._attachMouseoverCaptureEventListener();
                break;

            case MESSAGES.DOWNSTREAM.SET_IGNORED_CLASSES:
                // TODO ugly
                this._uniqueSelector._opts.ignoredClasses = data.classes;
                return;

            case MESSAGES.DOWNSTREAM.SET_UNIQUE_SELECTOR_OPTIONS:
                this._uniqueSelector = new UniqueSelector(data.options);
                break;

            case MESSAGES.DOWNSTREAM.TERMINATE_PUPPET:
                this._isTerminating = true;
                break;

            default:
                throw new Error('BrowserPuppet: unknown message type: ' + data.type);
        }

        log.info('Sending ACK message');
        this._sendMessage({ type: MESSAGES.UPSTREAM.ACK, result: result });
    }
    catch (err) {
        const errorDTO = {};

        Object.keys(err).forEach(function (key) {
            if (!err.hasOwnProperty(key)) {
                return;
            }
            errorDTO[key] = err[key];
        });

        errorDTO.message = err.message;
        errorDTO.stack = err.stack;

        this._sendMessage({ type: MESSAGES.UPSTREAM.NAK, error: errorDTO });
    }
    finally {
        this._isExecuting = false;

        if (this._isTerminating) {
            this._wsConn.close();
            this._wsConn = null;
        }
    }
};

BrowserPuppet.prototype._canCapture = function () {
    return this._transmitEvents && !this._isExecuting;
};

BrowserPuppet.prototype._attachCaptureEventListeners = function () {
    document.addEventListener('click', this._onClickCapture.bind(this), true);
    document.addEventListener('focus', this._onFocusCapture.bind(this), true);
    document.addEventListener('input', this._onInputCapture.bind(this), true);
    document.addEventListener('scroll', this._onScrollCapture.bind(this), true);
    document.addEventListener('keydown', this._onKeydownCapture.bind(this), true);
    document.addEventListener('change', this._onChangeCapture.bind(this), true);

    window.addEventListener('blur', this._onWindowBlur.bind(this));
};

BrowserPuppet.prototype._attachConsolePipe = function () {
    const self = this;
    // var oldLog = console.log;
    // var oldInfo = console.info;
    const oldWarn = console.warn;
    const oldError = console.error;

    function sendConsoleMessageIfConnected(messageType, args) {
        if (!self._wsConn.isConnected()) {
            return;
        }

        const message = Array.prototype.map.call(args, function (arg) {
            return String(arg);
        })
        .join(' ');

        self._sendMessage({
            type: MESSAGES.UPSTREAM.CONSOLE_PIPE,
            messageType: messageType,
            message: message,
        });
    }

    // console.log = function () {
    //     oldLog.apply(console, arguments);
    //     sendConsoleMessageIfConnected('log', arguments);
    // };

    // console.info = function () {
    //     oldInfo.apply(console, arguments);
    //     sendConsoleMessageIfConnected('info', arguments);
    // };

    console.warn = function (...args) {
        oldWarn.apply(console, args);
        sendConsoleMessageIfConnected('warn', args);
    };

    console.error = function (...args) {
        oldError.apply(console, args);
        sendConsoleMessageIfConnected('error', args);
    };
};

BrowserPuppet.prototype._attachMouseoverCaptureEventListener = function () {
    // TODO check if listener is already attached
    document.body.addEventListener('mouseover', this._onMouseoverCapture.bind(this), true);
};

const SHIFT_KEY = 16;
const CTRL_KEY = 17;

BrowserPuppet.prototype._onClickCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'click',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            target: getTargetNodeDTO(target),
        },
    });
};

BrowserPuppet.prototype._onFocusCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    if (this._activeElementBeforeWindowBlur === target) {
        log.debug('focus capture prevented during window re-focus');
        this._activeElementBeforeWindowBlur = null;
        return;
    }

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'focus',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            target: getTargetNodeDTO(target),
        },
    });
};

BrowserPuppet.prototype._onInputCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'input',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            value: target.value,
            target: getTargetNodeDTO(target),
        },
    });
};

const SCROLL_DEBOUNCE = 500;

BrowserPuppet.prototype._onScrollCapture = debounce(function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    const targetDTO = getTargetNodeDTO(target);
    targetDTO.scrollTop = target.scrollTop;

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'scroll',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            target: targetDTO,
        },
    });
}, SCROLL_DEBOUNCE);

BrowserPuppet.prototype._onKeydownCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    if (event.keyCode === SHIFT_KEY && event.ctrlKey === true ||
        event.keyCode === CTRL_KEY && event.shiftKey === true) {

        this._sendInsertAssertionDebounced();
        return;
    }

    const target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'keydown',
            $timestamp: Date.now(),
            selector: selector,
            $fullSelectorPath: fullSelectorPath,
            keyCode: event.keyCode || event.charCode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            target: getTargetNodeDTO(target),
        },
    });
};

BrowserPuppet.prototype._onChangeCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    try {
        var selector = this._uniqueSelector.get(target);
        // var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
    }
    catch (err) {
        log.error(err);
        return;
    }

    this._sendMessage({
        type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
        event: {
            type: 'change',
            $timestamp: Date.now(),
            selector: selector,
            // $fullSelectorPath: fullSelectorPath,
            target: getTargetNodeDTO(target),
        },
    });
};

BrowserPuppet.prototype._onMouseoverCapture = function (event) {
    if (!this._canCapture()) {
        return;
    }

    const target = event.target;

    if (this.$(target).is(this._mouseoverSelector)) {
        try {
            var selector = this._uniqueSelector.get(target);
            var fullSelectorPath = this._uniqueSelector.getFullSelectorPath(target);
        }
        catch (err) {
            log.error(err);
            return;
        }

        this._sendMessage({
            type: MESSAGES.UPSTREAM.CAPTURED_EVENT,
            event: {
                type: 'mouseover',
                $timestamp: Date.now(),
                selector: selector,
                $fullSelectorPath: fullSelectorPath,
                target: getTargetNodeDTO(target),
            },
        });
    }

};

BrowserPuppet.prototype._onWindowBlur = function () {
    this._activeElementBeforeWindowBlur = document.activeElement;
};

BrowserPuppet.prototype._sendInsertAssertionDebounced = debounce(function () {
    this._sendMessage({ type: MESSAGES.UPSTREAM.INSERT_ASSERTION });
}, INSERT_ASSERTION_DEBOUNCE);

BrowserPuppet.prototype.setOnSelectorBecameVisibleSelectors = function (selectors) {
    const self = this;

    if (self._selectorObserver !== null) {
        self._selectorObserver.disconnect();
        self._selectorObserver = null;
    }

    // TODO check _canCapture

    const observeList = selectors.map(function (selector) {
        return {
            selector: selector,
            listener: self._sendMessage.bind(self, { type: MESSAGES.UPSTREAM.SELECTOR_BECAME_VISIBLE, selector: selector }),
        };
    });

    this._selectorObserver = new SelectorObserver({ observeList: observeList });
};

BrowserPuppet.prototype.setTransmitEvents = function (value) {
    if (typeof value !== 'boolean') {
        throw new Error('BrowserPuppet::setTransmitEvents: invalid type for value');
    }
    this._transmitEvents = value;
};

BrowserPuppet.prototype._onExecMessage = async function (data) {
    if (data.type === MESSAGES.DOWNSTREAM.EXEC_COMMAND) {
        return this.execCommand(data.command);
    }
    else if (data.type === MESSAGES.DOWNSTREAM.EXEC_FUNCTION) {
        return this.execFunction(data.fn, data.args);
    }

    throw new Error('Unknown exec type: ' + data.type);

};

BrowserPuppet.prototype.execFunction = async function (fn, args) {
    return fn(...args);
};

BrowserPuppet.prototype.execCommand = async function (command) {
    // log.trace('execCommand: ' + JSON.stringify(command));

    switch (command.type) {
        case 'click':
        case 'setValue':
        case 'getValue':
        case 'pressKey':
        case 'waitForVisible':
        case 'waitWhileVisible':
        case 'focus':
        case 'isVisible':
        case 'scroll':
        case 'scrollTo':
        case 'mouseover':
        case 'uploadFileAndAssign':
            return this[command.type](command);

        case 'composite':
            return this.execCompositeCommand(command.commands);
        default:
            throw new Error('Unknown command type: ' + command.type);
    }
};

BrowserPuppet.prototype.execCompositeCommand = async function (commands) {
    for (const command of commands) {
        await this.execCommand(command);
    }
};

// TODO separate file
// from https://stackoverflow.com/a/179514/4782902
function deleteAllCookies() {
    const cookies = document.cookie.split(';');

    for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
}

BrowserPuppet.prototype.clearPersistentData = function () {
    deleteAllCookies();
    window.localStorage.clear();
};

function getTargetNodeDTO(target) {
    const dto = {
        className: target.className,
        id: target.id,
        innerText: target.innerText,
        tagName: target.tagName,
        type: target.type,
    };

    const attributes = target.attributes;

    __each(target.attributes, function (attr) {
        if (attr.name.indexOf('data-') === 0) {
            dto[attr.name] = attr.value;
        }
    });

    if (target.tagName === 'INPUT' && target.type === 'file') {
        dto.$fileNames = __map(target.files, function (file) {
            return file.name;
        });
    }

    return dto;
}

function assert(v, m) {
    if (!v) {
        throw new Error(m);
    }
}

function __map(arrayLike, iteratee) {
    const result = [];

    for (let i = 0; i < arrayLike.length; i++) {
        result.push(iteratee(arrayLike[i], i, arrayLike));
    }

    return result;
}

function __each(arrayLike, iteratee) {
    for (let i = 0; i < arrayLike.length; i++) {
        iteratee(arrayLike[i], i, arrayLike);
    }
}
