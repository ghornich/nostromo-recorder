(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
'use strict';

window.GetUniqueSelector = require('../');

},{"../":3}],2:[function(require,module,exports){
'use strict';

const DOMUtils = exports;

DOMUtils.hasId = function (node) {
    return Boolean(node && typeof node.id === 'string' && node.id.trim().length > 0);
};

DOMUtils.getId = function (node) {
    return node.id.trim();
};

DOMUtils.hasClass = function (node) {
    return Boolean(node && typeof node.className === 'string' && node.className.trim().length > 0);
};

DOMUtils.getClass = function (node) {
    return node.className.trim();
};

},{}],3:[function(require,module,exports){
'use strict';

const DOMUtils = require('./dom-utils');
const SelectorElement = require('./selector-element');
const SelectorElementList = require('./selector-element-list');

exports = module.exports = UniqueSelector;

/**
 * @typedef {Object} UniqueSelectorOptions
 * @property {Function} [querySelectorAll]
 * @property {Array<String>} [ignoredClasses] - ignored class names (without leading '.')
 * @property {Boolean} [useIds = true]
 * @property {RegExp} [preferredClass] - e.g. /test--[^ ]+/
 * @property {Boolean} [useClosestParentWithPreferredClass = false]
 * @property {Number} [preferredClassParentLimit = 0]
 */

/**
 * @param {UniqueSelectorOptions} options
 */
function UniqueSelector(options) {
    // TODO test all options
    this._opts = Object.assign({}, {
        // @ts-expect-error
        querySelectorAll: document.querySelectorAll.bind(document),
        ignoredClasses: [],
        useIds: true,
        // regex
        preferredClass: null,
        useClosestParentWithPreferredClass: false,
        preferredClassParentLimit: 0,
    }, options);

    if (this._opts.preferredClass && this._opts.preferredClass.global) {
        throw new Error('Global flag not allowed for "preferredClass"');
    }
}

UniqueSelector.prototype.get = function (node) {
    let _node = node;

    if (this._opts.useIds && DOMUtils.hasId(_node)) {
        return '#' + DOMUtils.getId(_node);
    }

    // traverse up until prefClass is found or max depth reached or body reached
    if (this._opts.preferredClass && this._opts.useClosestParentWithPreferredClass) {
        let currentNode = _node;
        let depth = 0;
        const depthLimit = 1000;

        while (currentNode && currentNode.tagName !== 'BODY') {
            if (depth >= this._opts.preferredClassParentLimit) {
                break;
            }

            if (depth >= depthLimit) {
                throw new Error('Infinite loop error');
            }

            if (this._opts.preferredClass.test(currentNode.className)) {
                _node = currentNode;
                break;
            }

            currentNode = currentNode.parentNode;
            depth++;
        }
    }

    const selectorElementList = this._getParentSelectorPath(_node);

    selectorElementList.simplify();

    if (!selectorElementList.isUnique()) {
        selectorElementList.uniqueify();
    }

    selectorElementList.simplifyClasses(false);

    if (this._opts.preferredClass) {
        // run simplify alg again, remove unnecessary preferred classes
        selectorElementList.simplify(false);
    }

    return selectorElementList.getSelectorPath();
};

UniqueSelector.prototype._getParentSelectorPath = function (node) {
    const selectorElementList = new SelectorElementList(this._opts);

    let currentNode = node;

    while (currentNode && currentNode.tagName !== 'BODY') {
        const selectorElement = new SelectorElement(currentNode, this._opts);

        selectorElementList.addElement(selectorElement);

        if (this._opts.useIds && selectorElement.type === SelectorElement.TYPE.ID) {
            break;
        }

        currentNode = currentNode.parentNode;
    }

    return selectorElementList;
};

UniqueSelector.prototype.getFullSelectorPath = function (node) {
    return this._getParentSelectorPath(node).getSelectorPath();
};

},{"./dom-utils":2,"./selector-element":5,"./selector-element-list":4}],4:[function(require,module,exports){
// @ts-nocheck
'use strict';

const SelectorElement = require('./selector-element');

exports = module.exports = SelectorElementList;

function SelectorElementList(options) {
    this._opts = {
        querySelectorAll: document.querySelectorAll.bind(document),
        ...options
    };

    this._selectorElements = [];

    Object.seal(this);
}

SelectorElementList.prototype.getSelectorPath = function () {
    return this._selectorElements
    .map(function (selectorElement) {
        return (selectorElement.selector || '');
    })
    .join('>')
    .replace(/>{2,}/g, ' ')
    .replace(/^>|>$/, '')
    .replace(/>/g, ' > ')
    .trim();
};

SelectorElementList.prototype.toString = SelectorElementList.prototype.getSelectorPath;

SelectorElementList.prototype.addElement = function (element) {
    this._selectorElements.unshift(element);
};

SelectorElementList.prototype.getAmbiguity = function () {
    return this._opts.querySelectorAll(this.getSelectorPath()).length;
};

SelectorElementList.prototype.isUnique = function () {
    return this.getAmbiguity() === 1;
};

SelectorElementList.prototype.simplify = function (enableUsePreferredClass) {
    const ambiguity = this.getAmbiguity();
    enableUsePreferredClass = enableUsePreferredClass === undefined ? true : enableUsePreferredClass;

    for (let i = 0, len = this._selectorElements.length; i < len - 1; i++) {
        const selectorElement = this._selectorElements[i];
        const isTypeOfClass = selectorElement.type === SelectorElement.TYPE.CLASS;

        if (!selectorElement.active) {
            continue;
        }

        if (enableUsePreferredClass && this._opts.preferredClass && isTypeOfClass && this._opts.preferredClass.test(selectorElement.selector)) {
            continue;
        }

        selectorElement.active = false;

        const newAmbiguity = this.getAmbiguity();

        if (ambiguity !== newAmbiguity) {
            selectorElement.active = true;
        }
    }
};

SelectorElementList.prototype.simplifyClasses = function (enableUsePreferredClass) {
    enableUsePreferredClass = enableUsePreferredClass === undefined ? true : enableUsePreferredClass;

    for (let selectorElementIdx = 0, len = this._selectorElements.length; selectorElementIdx < len; selectorElementIdx++) {
        const selectorElement = this._selectorElements[selectorElementIdx];

        if (!selectorElement.active || selectorElement.type !== SelectorElement.TYPE.CLASS) {
            continue;
        }

        const originalSelector = selectorElement.rawSelector;
        const classList = new ClassList(originalSelector);

        if (classList.length > 1) {
            for (let classIdx = classList.length - 1; classIdx >= 0; classIdx--) {
                const classListElement = classList.get(classIdx);

                if (enableUsePreferredClass && this._opts.preferredClass && this._opts.preferredClass.test(classListElement.className)) {
                    continue;
                }

                classListElement.enabled = false;
                selectorElement.rawSelector = classList.getSelector();

                if (selectorElement.rawSelector === '' || this.getAmbiguity() > 1) {
                    classListElement.enabled = true;
                }
            }

            selectorElement.rawSelector = classList.getSelector();
        }
    }

};

function ClassList(classSelector) {
    this.classListElements = classSelector.split(/(?=\.)/g).map(function (className) {
        return new ClassListElement(className);
    });

    Object.defineProperty(this, 'length', {
        get: function () {
            return this.classListElements.length;
        },
    });
}

ClassList.prototype.get = function (i) {
    return this.classListElements[i];
};

ClassList.prototype.getSelector = function () {
    return this.classListElements.map(function (cle) {
        return cle.enabled
            ? cle.className
            : null;
    })
    .filter(function (s) {
        return s;
    })
    .join('');
};

function ClassListElement(className) {
    this.enabled = true;
    this.className = className;
}

/**
 * add "nth-child"s from back until selector becomes unique
 */
SelectorElementList.prototype.uniqueify = function () {
    let ambiguity = this.getAmbiguity();

    for (let i = this._selectorElements.length - 1; i >= 0; i--) {
        const selectorElement = this._selectorElements[i];
        const prevActiveValue = selectorElement.active;

        selectorElement.active = true;
        selectorElement.useNthChild = true;

        const newAmbiguity = this.getAmbiguity();

        // TODO error check: newAmbiguity < 1

        if (newAmbiguity < ambiguity) {
            ambiguity = newAmbiguity;

            if (ambiguity === 1) {
                break;
            }
        }
        else {
            selectorElement.useNthChild = false;
            selectorElement.active = prevActiveValue;
        }
    }
};

},{"./selector-element":5}],5:[function(require,module,exports){
// @ts-nocheck
'use strict';

const DOMUtils = require('./dom-utils');


/**
 * Represents a single DOM node's selector, e.g.:
 *
 * .class1 .class2.red span [name="user"]
 * |-----| |---------| |--| |-----------|
 *
 *
 */

class SelectorElement {
    constructor(node, options) {
        const nodeSelectorData = SelectorElement._getNodeSelectorData(node, options);

        this._node = node;
        this._rawSelector = nodeSelectorData.selector;
        this._type = nodeSelectorData.type;
        this._active = true;
        this._useNthChild = false;
        this._nthChild = Array.prototype.indexOf.call(node.parentNode.children, node) + 1;
    }

    get node() {
        return this._node;
    }

    get rawSelector() {
        if (!this._active) {
            return null;
        }

        return this._rawSelector;
    }

    set rawSelector(val) {
        // TODO enforce selector type?
        this._rawSelector = val;
    }

    get selector() {
        if (!this._active) {
            return null;
        }

        return this._rawSelector + (this._useNthChild ? ':nth-child(' + this._nthChild + ')' : '');
    }

    get type() {
        return this._type;
    }

    get active() {
        return this._active;
    }

    set active(val) {
        if (typeof val !== 'boolean') {
            throw new Error('Invalid type for "active"');
        }

        this._active = val;
    }

    get useNthChild() {
        return this._useNthChild;
    }
    set useNthChild(val) {
        if (typeof val !== 'boolean') {
            throw new Error('Invalid type for "useNthChild"');
        }

        this._useNthChild = val;
    }

    /**
     * [getSelectorStringData description]
     * @param  {Object} node [description]
     * @return {Object} { selector: String, type: Number }
     */
    static _getNodeSelectorData(node, rawOptions) {
        if (!node || !('tagName' in node)) {
            const error = new Error('SelectorElement::_getNodeSelectorData: invalid node');
            error.type = SelectorElement.ERROR.INVALID_NODE;
            throw error;
        }

        const options = rawOptions || {};
        options.ignoredClasses = options.ignoredClasses || [];

        if (options.useIds && DOMUtils.hasId(node)) {
            return {
                selector: '#' + DOMUtils.getId(node),
                type: SelectorElement.TYPE.ID,
            };
        }

        if (DOMUtils.hasClass(node)) {
            let classNames = DOMUtils.getClass(node);

            options.ignoredClasses.forEach(function (ignoredClass) {
                const replaceRegex = new RegExp('(^|\\s+)' + ignoredClass + '($|\\s+)', 'i');

                classNames = classNames.replace(replaceRegex, ' ');
            });

            if (options.preferredClass && options.preferredClass.test(classNames)) {
                const regex = new RegExp(options.preferredClass.source, 'g');
                let match;
                const matches = [];

                // eslint-disable-next-line no-cond-assign
                while (match = regex.exec(classNames)) {
                    matches.push(match[0]);
                }

                classNames = matches.join(' ');
            }

            classNames = classNames.trim();

            if (classNames.length > 0) {
                return {
                    selector: '.' + classNames.replace(/ +/g, '.'),
                    type: SelectorElement.TYPE.CLASS,
                };
            }
        }

        const maybeNameAttr = (node.getAttribute('name') || '').trim();

        if (maybeNameAttr.length > 0) {
            return {
                selector: node.tagName.toLowerCase() + '[name="' + maybeNameAttr + '"]',
                type: SelectorElement.TYPE.ATTR,
            };
        }

        return {
            selector: node.tagName.toLowerCase(),
            type: SelectorElement.TYPE.TAG,
        };
    }
}

SelectorElement.TYPE = {
    ID: 0,
    CLASS: 1,
    ATTR: 2,
    TAG: 3,
};

SelectorElement.ERROR = {
    INVALID_NODE: 0,
};

module.exports = SelectorElement;

},{"./dom-utils":2}]},{},[1]);
