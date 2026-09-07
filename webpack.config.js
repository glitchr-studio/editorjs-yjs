module.exports = {
  entry: './src/index.js',
  // yjs and y-websocket must not be bundled in - Yjs keeps an internal
  // module-identity registry and warns/misbehaves ("Yjs was already
  // imported. This breaks constructor checks...") the moment two separate
  // copies of it exist on the same page. A consuming app's own bundler
  // (this is meant to be consumed via a bundler, not a bare <script> tag)
  // already needs its own real yjs/y-websocket dependency for its own
  // collaboration code (e.g. base-bundle's form-type-collab-presence.js) -
  // externalizing these means both this package and the host share that
  // exact same module instance instead of each carrying a private copy.
  externals: {
    yjs: {
      commonjs: 'yjs',
      commonjs2: 'yjs',
      amd: 'yjs',
      root: 'Y',
    },
    'y-websocket': {
      commonjs: 'y-websocket',
      commonjs2: 'y-websocket',
      amd: 'y-websocket',
      root: 'YWebsocket',
    },
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'babel-loader',
            options: {
              presets: [ '@babel/preset-env' ],
            },
          },
        ]
      },
      {
        test: /\.css$/,
        use: [
          'style-loader',
          'css-loader'
        ]
      }
    ]
  },
  output: {
    path: __dirname + '/dist',
    publicPath: '/',
    filename: 'bundle.js',
    library: 'EditorYjs',
    libraryTarget: 'umd'
  }
};
