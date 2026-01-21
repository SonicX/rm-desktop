/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/consistent-type-definitions */
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

interface Window {
  screenCapture?: ScreenCaptureAPI;
  nativeTestStream?: MediaStream | null;
  electronNativeStream?: MediaStream;
  electron_bridge?: any;
  api?: any;
  ipcRenderer?: {
    invoke(channel: string, ...arguments_: any[]): Promise<any>;
    on(
      channel: string,
      listener: (event: any, ...arguments_: any[]) => void,
    ): void;
  };
}
