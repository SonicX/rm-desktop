import { ipcRenderer } from "../typed-ipc-renderer.js";

export const connectivityError: string[] = [
  "ERR_INTERNET_DISCONNECTED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_CONNECTION_RESET",
  "ERR_NOT_CONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NETWORK_CHANGED",
];

let userAgent: string | null = null;

async function fetchUserAgent() {
  if (!userAgent) {
    const result = await ipcRenderer.invoke("fetch-user-agent");
    if (typeof result === "string") {
      userAgent = result;
    } else {
      throw new Error("Unexpected user-agent value: " + result);
    }
  }
  return userAgent;
}

export async function getUserAgent(): Promise<string> {
  return fetchUserAgent();
}