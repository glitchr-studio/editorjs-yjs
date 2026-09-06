// Restored alongside the patched sources: the package ships no config of its
// own, and `dist/bundle.js` is what package.json's `main` points at - so
// patching src/ without rebuilding leaves the old, unfixed bundle in place.
//
// Shape matched to the bundle this replaces: UMD named EditorYjs, returning
// the module namespace (the consumer does `m.default || m`), with yjs and
// y-websocket kept EXTERNAL so a second copy of yjs never lands on the page -
// two Yjs instances on one document is its own class of corruption.
const path = require('path');

module.exports = {
    mode: 'production',
    entry: './src/index.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js',
        globalObject: 'self',
        library: { name: 'EditorYjs', type: 'umd' },
    },
    // PresenceTune.js imports src/index.css (the remote-cursor styling), so the
    // bundle needs to carry its own CSS - injected at runtime, since consumers
    // import this package as a plain module and have nowhere to put a
    // separate stylesheet.
    module: {
        rules: [{ test: /\.css$/i, use: ['style-loader', 'css-loader'] }],
    },
    externals: {
        'y-websocket': { commonjs: 'y-websocket', commonjs2: 'y-websocket', amd: 'y-websocket', root: 'YWebsocket' },
        yjs: { commonjs: 'yjs', commonjs2: 'yjs', amd: 'yjs', root: 'Y' },
    },
};
