/* eslint-disable @typescript-eslint/no-unused-vars */
import path from "node:path";
import process from "node:process";
import url from "node:url";

export const bundlePath = __dirname;

export const publicPath = bundlePath;

export const bundleUrl = url.pathToFileURL(__dirname).href + "/";

export const publicUrl = bundleUrl;
