/* eslint-disable no-undef */
import path from 'path';

export default {
  target: 'node', // VS Code extensions run in Node
  entry: {
    extension: './src/extension.ts',
    'scan.worker': './node_modules/tsgrep/dist/scan.worker.js',
  }, // entry point of your extension
  output: {
    path: path.resolve(process.cwd(), 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode', // don't bundle VS Code's own API
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
};
