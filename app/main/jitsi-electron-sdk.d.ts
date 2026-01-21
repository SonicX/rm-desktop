declare module "@jitsi/electron-sdk" {
  import type {BrowserWindow} from "electron/main";

  export type JitsiMeetElectronOptions = {
    window?: BrowserWindow;
    domain: string;
    roomName: string;
    width?: number;
    height?: number;
    configOverwrite?: any;
    interfaceConfigOverwrite?: any;
    userInfo?: {
      displayName?: string;
      email?: string;
    };
    onload?: () => void;
  };

  export class JitsiMeetElectron {
    constructor(options: JitsiMeetElectronOptions);
    on(event: string, callback: (...arguments_: any[]) => void): void;
    off(event: string, callback: (...arguments_: any[]) => void): void;
    send(event: string, data?: any): void;
    dispose(): void;
  }
}
