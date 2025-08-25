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
              external: ["electron", /^electron\//, /^node:/, "path", "fs", "crypto", "os", "util"],
            },
            ssr: true,
          },
          resolve: {
            alias: {
              "zulip:remote": "electron/main",
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
              external: ["electron", /^electron\//, /\.node$/, /^node:/, "path", "fs", "crypto", "os", "util"],
            },
          },
          resolve: {
            conditions: ['node'],
            browserField: false,
          },
          ssr: {
            noExternal: /^(?!.*\.node$).*/,
            external: [/\.node$/, /^node:/, "path", "fs", "crypto", "os", "util"],
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
              external: ["electron", /^electron\//],
            },
          },
          resolve: {
            alias: {
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