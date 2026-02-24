/* eslint-disable @typescript-eslint/naming-convention */

import * as path from "node:path";

import {defineConfig} from "vite";
import electron from "vite-plugin-electron";

export default defineConfig({
  plugins: [
    electron([
      {
        entry: {
          index: "app/main",
        },
        vite: {
          build: {
            sourcemap: true,
            rollupOptions: {
              external: [
                "electron",
                /^node:/,
                "path",
                "fs",
                "crypto",
                "os",
                "util",
              ],
            },
            ssr: true,
          },
          resolve: {
            alias: {
              "electron/main": "electron",
              "electron/renderer": "electron",
              "electron/common": "electron",
              "zulip:remote": "electron",
            },
          },
          ssr: {
            noExternal: true,
          },
        },
      },
      {
        entry: {
          preload: "app/renderer/js/preload.ts",
        },
        vite: {
          build: {
            sourcemap: "inline",
            rollupOptions: {
              external: [
                "electron",
                /\.node$/,
                /^node:/,
                "path",
                "fs",
                "crypto",
                "os",
                "util",
              ],
            },
          },
          resolve: {
            alias: {
              "electron/main": "electron",
              "electron/renderer": "electron",
              "electron/common": "electron",
            },
            conditions: ["node"],
            mainFields: ["module", "main"], // Alternative to browserField
          },
          ssr: {
            noExternal: true, // Bundle everything except externals
            external: [
              "*.node",
              "electron",
              "path",
              "fs",
              "crypto",
              "os",
              "util",
            ],
          },
        },
      },
      {
        entry: {
          renderer: "app/renderer/js/main.ts",
        },
        vite: {
          build: {
            sourcemap: true,
            rollupOptions: {
              external: ["electron"],
            },
          },
          resolve: {
            alias: {
              "electron/main": "electron",
              "electron/renderer": "electron",
              "electron/common": "electron",
              "zulip:remote": "@electron/remote",
            },
          },
        },
      },
    ]),
  ],
  build: {
    outDir: "dist-electron",
    sourcemap: true,
    rollupOptions: {
      input: {
        renderer: path.join(__dirname, "app/renderer/main.html"),
        network: path.join(__dirname, "app/renderer/network.html"),
        about: path.join(__dirname, "app/renderer/about.html"),
        preference: path.join(__dirname, "app/renderer/preference.html"),
      },
    },
  },
});
