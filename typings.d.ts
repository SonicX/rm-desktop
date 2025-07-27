declare module "zulip:remote" {
  export const {
    app,
    dialog,
  }: typeof import("electron/main") | typeof import("@electron/remote");
}
interface ScreenCaptureOptions {
  sourceId: string;
  width: number;
  height: number;
  frameRate: number;
}

interface FrameStats {
  videoFrames: number;
  audioFrames: number;
  isActive: boolean;
}

interface ScreenCaptureAPI {
  startCapture(options: ScreenCaptureOptions): Promise<boolean>;
  stopCapture(): Promise<void>;
  getFrameStats(): FrameStats;
  testMethod(): string;
}

declare global {
  interface Window {
    screenCapture?: ScreenCaptureAPI;
    ipcRenderer?: {
      invoke(channel: string, ...args: any[]): Promise<any>;
      on(channel: string, listener: (event: any, ...args: any[]) => void): void;
    };
  }
}
