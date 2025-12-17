const path = require("path");

module.exports = {
  entry: "./src/main.js",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "public"),
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env"],
          },
        },
      },
    ],
  },
  devServer: {
    static: {
      directory: path.join(__dirname, "public"),
    },
    port: 3000,
    host: "0.0.0.0", // 모든 네트워크 인터페이스에서 접근 가능
    hot: true,
    compress: true,
    open: false, // 자동 오픈 비활성화 (원격 접근 시 불필요)
    allowedHosts: "all", // 모든 호스트에서 접근 허용
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  mode: "development",
  devtool: "source-map",
};
