declare module '@jitsi/electron-sdk' {
    import { BrowserWindow } from 'electron';
    
    export interface JitsiMeetElectronOptions {
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
    }
    
    export class JitsiMeetElectron {
        constructor(options: JitsiMeetElectronOptions);
        on(event: string, callback: (...args: any[]) => void): void;
        off(event: string, callback: (...args: any[]) => void): void;
        send(event: string, data?: any): void;
        dispose(): void;
    }
}