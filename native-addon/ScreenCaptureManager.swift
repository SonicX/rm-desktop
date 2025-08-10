// CMSampleBuffer+Extensions.swift
import CoreMedia
import CoreVideo

extension CMSampleBuffer {
    func getImageBuffer() -> CVImageBuffer? {
        return CMSampleBufferGetImageBuffer(self)
    }
    
    func getVideoFrame() -> [String: Any]? {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(self) else { return nil }
        
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(self).seconds
        
        // Блокируем буфер для чтения
        CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly) }
        
        // Получаем указатель на данные
        let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer)
        let bufferSize = bytesPerRow * height
        
        // Создаем Data из буфера
        var frameData: Data?
        if let baseAddress = baseAddress {
            frameData = Data(bytes: baseAddress, count: bufferSize)
        }
        
        return [
            "width": width,
            "height": height,
            "timestamp": timestamp,
            "pixelFormat": CVPixelBufferGetPixelFormatType(imageBuffer),
            "bytesPerRow": bytesPerRow,
            "dataSize": bufferSize,
            // Для WebRTC нужны только метаданные, сами данные передаем отдельно
            "hasData": frameData != nil
        ]
    }

    func getAudioData() -> [String: Any]? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(self) else { return nil }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return nil }
        
        let numSamples = CMSampleBufferGetNumSamples(self)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(self).seconds
        
        // Получаем аудио данные
        var audioBufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            self,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        
        defer {
            // Удаляем неиспользуемую проверку
            _ = blockBuffer  // Подавляем warning
        }
        
        var audioData: Data?
        var totalSize: Int = 0
        
        if status == noErr {
            // Если получили AudioBufferList, извлекаем данные
            let bufferCount = Int(audioBufferList.mNumberBuffers)
            if bufferCount > 0 {
                // Для простоты берем первый буфер (обычно интерливд стерео)
                let audioBuffer = audioBufferList.mBuffers
                if let data = audioBuffer.mData, audioBuffer.mDataByteSize > 0 {
                    audioData = Data(bytes: data, count: Int(audioBuffer.mDataByteSize))
                    totalSize = Int(audioBuffer.mDataByteSize)
                }
            }
        }
        
        return [
            "sampleRate": asbd.pointee.mSampleRate,
            "channels": asbd.pointee.mChannelsPerFrame,
            "timestamp": timestamp,
            "numSamples": numSamples,
            "format": asbd.pointee.mFormatID,
            "bitsPerChannel": asbd.pointee.mBitsPerChannel,
            "bytesPerFrame": asbd.pointee.mBytesPerFrame,
            "framesPerPacket": asbd.pointee.mFramesPerPacket,
            "hasData": audioData != nil,
            "dataSize": totalSize
        ]
    }
}

// ScreenCaptureManager.swift
import Foundation
import ScreenCaptureKit
@preconcurrency import AVFoundation
import AppKit
import CoreMedia

struct CaptureSource: Sendable {
    let type: String
    let id: String
}

class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) {
        self.value = value
    }
}

@available(macOS 12.3, *)
actor CaptureActor {
    var isCapturing = false
    var errorMessage: String?
    var isStreaming = false

    private var pickerCompletion: ((NSError?, [String: Any]?) -> Void)?
    private var stream: SCStream?
    private var captureSession: AVCaptureSession?
    private var contentFilter: SCContentFilter?
    private var captureWidth: Int = 0
    private var captureHeight: Int = 0
    private let sampleBufferQueue = DispatchQueue(label: "ScreenCaptureManager.SampleBufferQueue")
    private var firstSampleTime: CMTime = .zero
    private var lastVideoTime: CMTime = .zero
    private var lastAudioTime: CMTime = .zero
    private let outputDelegate: CaptureOutputDelegate
    private var directVideoCallback: ((CVImageBuffer, Double) -> Void)?
    private var directAudioCallback: ((CMSampleBuffer) -> Void)?

    // WebRTC callbacks
    var videoBufferCallback: ((CMSampleBuffer) -> Void)?
    var audioBufferCallback: ((CMSampleBuffer) -> Void)?
    var webrtcVideoCallback: (([String: Any]) -> Void)?
    var webrtcAudioCallback: ((CMSampleBuffer) -> Void)?

    init() {
        let delegate = CaptureOutputDelegate()
        self.outputDelegate = delegate
        delegate.actor = self
    }

    func setVideoCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        videoBufferCallback = callback
    }

    func setAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        audioBufferCallback = callback
    }
    
    func setWebRTCVideoCallback(_ callback: @escaping ([String: Any]) -> Void) {
        webrtcVideoCallback = callback
    }
    
    func setWebRTCAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        webrtcAudioCallback = callback
    }

    func setPickerCompletion(_ completion: @escaping (NSError?, [String: Any]?) -> Void) {
        pickerCompletion = completion
    }

    func getPickerCompletion() -> ((NSError?, [String: Any]?) -> Void)? {
        return pickerCompletion
    }

    func clearPickerCompletion() {
        pickerCompletion = nil
    }

    func handleStreamError(_ error: Error) {
        print("Stream stopped with error: \(error.localizedDescription)")
        isStreaming = false
    }

    // Add these safety checks to your setCaptureSource method in ScreenCaptureManager.swift

    func setCaptureSource(type: String, id: String) async throws {
        print("🔍 setCaptureSource called with type: \(type), id: \(id)")
        
        do {
            let contentTask = Task { @MainActor in
                try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            }
            let content = try await contentTask.value
            print("✅ Got shareable content with \(content.displays.count) displays and \(content.windows.count) windows")
            
            if type == "display" {
                guard let displayID = UInt32(id) else {
                    print("❌ Invalid display ID: \(id)")
                    throw RecordingError("Invalid display ID: \(id)")
                }
                
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    print("❌ Display not found with ID: \(displayID)")
                    print("📋 Available displays: \(content.displays.map { $0.displayID })")
                    throw RecordingError("Screen not found with ID: \(displayID)")
                }
                
                print("✅ Found display: \(display.displayID), size: \(display.width)x\(display.height)")
                contentFilter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                captureWidth = display.width
                captureHeight = display.height
                
            } else if type == "window" {
                guard let windowID = UInt32(id) else {
                    print("❌ Invalid window ID: \(id)")
                    throw RecordingError("Invalid window ID: \(id)")
                }
                
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    print("❌ Window not found with ID: \(windowID)")
                    print("📋 Available windows: \(content.windows.prefix(10).map { "\($0.windowID): \($0.title ?? "No title")" })")
                    throw RecordingError("Window not found with ID: \(windowID)")
                }
                
                print("✅ Found window: \(window.windowID), title: '\(window.title ?? "No title")', size: \(window.frame.width)x\(window.frame.height)")
                
                // Check if window is valid for capture
                if window.frame.width < 10 || window.frame.height < 10 {
                    print("⚠️ Window too small for capture: \(window.frame.width)x\(window.frame.height)")
                    throw RecordingError("Window too small for capture")
                }
                
                contentFilter = SCContentFilter(desktopIndependentWindow: window)
                captureWidth = Int(window.frame.width)
                captureHeight = Int(window.frame.height)
                
            } else if type == "application" {
                guard let app = content.applications.first(where: { $0.bundleIdentifier == id }) else {
                    print("❌ Application not found with bundle ID: \(id)")
                    print("📋 Available apps: \(content.applications.prefix(5).map { $0.bundleIdentifier })")
                    throw RecordingError("Application not found with bundle ID: \(id)")
                }
                
                let mainDisplay = content.displays.first!
                contentFilter = SCContentFilter(display: mainDisplay, including: [app], exceptingWindows: [])
                captureWidth = mainDisplay.width
                captureHeight = mainDisplay.height
                print("✅ Found application: \(app.applicationName)")
                
            } else {
                print("❌ Unsupported source type: \(type)")
                throw RecordingError("Unsupported source type: \(type)")
            }
            
            print("✅ setCaptureSource completed successfully for \(type):\(id)")
            
        } catch {
            print("❌ setCaptureSource failed: \(error.localizedDescription)")
            throw error
        }
    }

    func selectSource() async throws -> CaptureSource {
        let contentTask = Task { @MainActor in
            try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        }
        let content = try await contentTask.value
        
        var sourceList: [CaptureSource] = []
        var displayNames: [String] = []
        
        for (i, display) in content.displays.enumerated() {
            let name = "Screen \(i + 1)"
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "display", id: "\(display.displayID)"))
        }
        
        for window in content.windows {
            let name = "\(window.title ?? "Untitled") - \(window.owningApplication?.applicationName ?? "Unknown")"
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "window", id: "\(window.windowID)"))
        }
        
        for app in content.applications {
            let name = app.applicationName
            displayNames.append(name)
            sourceList.append(CaptureSource(type: "application", id: app.bundleIdentifier))
        }
        
        return try await withCheckedThrowingContinuation { continuation in
            Task.detached { [displayNames, sourceList] in
                let selectedSource = await MainActor.run { () -> CaptureSource? in
                    let alert = NSAlert()
                    alert.messageText = "Select Source to Capture"
                    alert.informativeText = "Choose a screen, window, or application"
                    
                    let popUp = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 400, height: 24), pullsDown: false)
                    popUp.addItems(withTitles: displayNames)
                    
                    alert.accessoryView = popUp
                    
                    alert.addButton(withTitle: "Select")
                    alert.addButton(withTitle: "Cancel")
                    
                    let response = alert.runModal()
                    if response == .alertFirstButtonReturn {
                        let selectedIndex = popUp.indexOfSelectedItem
                        if selectedIndex >= 0 {
                            return sourceList[selectedIndex]
                        } else {
                            return nil
                        }
                    } else {
                        return nil
                    }
                }
                if let selectedSource = selectedSource {
                    continuation.resume(returning: selectedSource)
                } else {
                    continuation.resume(throwing: RecordingError("No selection or cancelled"))
                }
            }
        }
    }

    func startCapture() async throws {
        errorMessage = nil

        guard CGPreflightScreenCaptureAccess() else {
            print("No screen capture permission")
            errorMessage = "Screen capture permission denied."
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
            }
            throw RecordingError("No screen capture permission")
        }

        try await requestMicrophoneAccess()

        if contentFilter == nil {
            let selectedSource = try await selectSource()
            try await setCaptureSource(type: selectedSource.type, id: selectedSource.id)
        }

        let streamConfig = SCStreamConfiguration()
        streamConfig.width = captureWidth
        streamConfig.height = captureHeight
        
        if #available(macOS 13.0, *) {
            // КРИТИЧНО: Включаем захват системного аудио
            streamConfig.capturesAudio = true
            streamConfig.excludesCurrentProcessAudio = true // Исключаем звук самого Electron приложения
            streamConfig.sampleRate = 48000
            streamConfig.channelCount = 2 // Стерео для системного звука
            
            // ВАЖНО: Для захвата звука конкретного приложения при типе "application"
            if contentFilter != nil {
                // Это автоматически настроит захват аудио от выбранного источника
                print("Audio capture enabled for selected source")
            }
        }
        
        streamConfig.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        streamConfig.queueDepth = 3
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfig.showsCursor = true

        // Создаем сессию для микрофона (опционально)
        let session = AVCaptureSession()
        captureSession = session
        
        // Добавляем микрофон только если нужно
        if let audioDevice = AVCaptureDevice.default(for: .audio) {
            do {
                let audioInputDevice = try AVCaptureDeviceInput(device: audioDevice)
                if session.canAddInput(audioInputDevice) {
                    session.addInput(audioInputDevice)
                    print("Microphone audio input added")
                    
                    let audioOutput = AVCaptureAudioDataOutput()
                    audioOutput.setSampleBufferDelegate(outputDelegate, queue: sampleBufferQueue)
                    if session.canAddOutput(audioOutput) {
                        session.addOutput(audioOutput)
                        print("Microphone audio output added")
                    } else {
                        print("Failed to add microphone audio output")
                        captureSession = nil
                    }
                } else {
                    print("Failed to add microphone audio input")
                    captureSession = nil
                }
            } catch {
                print("Microphone setup error: \(error), continuing without mic")
                captureSession = nil
            }
        } else {
            print("Microphone unavailable, continuing without mic capture")
            captureSession = nil
        }

        let streamLocal = SCStream(filter: contentFilter!, configuration: streamConfig, delegate: outputDelegate)
        try streamLocal.addStreamOutput(outputDelegate, type: .screen, sampleHandlerQueue: sampleBufferQueue)
        
        if #available(macOS 13.0, *) {
            // Добавляем обработчик для системного аудио
            try streamLocal.addStreamOutput(outputDelegate, type: .audio, sampleHandlerQueue: sampleBufferQueue)
            print("System audio output handler added")
        }
        
        try await streamLocal.startCapture()
        
        // Запускаем сессию микрофона только если она была создана
        if let session = captureSession {
            session.startRunning()
            print("Microphone capture started")
        }
        
        self.stream = streamLocal
        isCapturing = true
        isStreaming = true
        print("Video and audio capture started with system audio support")
    }

    private func requestMicrophoneAccess() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            print("Microphone access granted")
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if granted {
                print("Microphone access obtained")
            } else {
                print("Microphone access denied")
                errorMessage = "Microphone access denied."
                throw RecordingError("Microphone access denied")
            }
        case .denied, .restricted:
            print("Microphone access denied or restricted")
            errorMessage = "Microphone access denied."
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
            }
            throw RecordingError("Microphone access denied")
        @unknown default:
            throw RecordingError("Unknown microphone access status")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) async {
        guard isCapturing && isStreaming else { return }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstSampleTime == .zero {
            firstSampleTime = presentationTime
        }
        
        let adjustedTime = presentationTime - firstSampleTime
        
        switch type {
        case .screen:
            if let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                // Прямая передача видео буфера
                directVideoCallback?(imageBuffer, adjustedTime.seconds)
                
                // Также отправляем в существующие callbacks
                videoBufferCallback?(sampleBuffer)
                if let frameData = sampleBuffer.getVideoFrame() {
                    webrtcVideoCallback?(frameData)
                }
            }
            
        case .audio:
            // ВАЖНО: Добавляем подробное логирование
            print("🎵 System audio buffer received, time: \(adjustedTime.seconds)")
            
            // Получаем информацию о формате для отладки
            if let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
                if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) {
                    let channelCount = asbd.pointee.mChannelsPerFrame
                    let sampleRate = asbd.pointee.mSampleRate
                    let formatID = asbd.pointee.mFormatID
                    print("🎵 Audio format - Channels: \(channelCount), Sample Rate: \(sampleRate), Format: \(formatID)")
                    
                    // Проверяем формат аудио
                    if formatID == kAudioFormatLinearPCM {
                        print("🎵 Audio is Linear PCM - good for processing")
                    } else {
                        print("⚠️ Audio format is not Linear PCM: \(formatID)")
                    }
                }
            }
            
            // Проверяем количество сэмплов
            let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
            print("🎵 Audio samples in buffer: \(numSamples)")
            
            // Прямая передача аудио буфера
            directAudioCallback?(sampleBuffer)
            
            // Также отправляем в существующие callbacks
            audioBufferCallback?(sampleBuffer)
            
            // КРИТИЧНО: Вызываем WebRTC callback
            if let callback = webrtcAudioCallback {
                print("🎵 Calling webrtcAudioCallback")
                callback(sampleBuffer)
            } else {
                print("⚠️ webrtcAudioCallback is nil!")
            }
            
        case .microphone:
            // Добавляем обработку микрофона (для полноты)
            print("🎵 Microphone audio buffer received, time: \(adjustedTime.seconds)")
            audioBufferCallback?(sampleBuffer)
            webrtcAudioCallback?(sampleBuffer)
            
        @unknown default:
            print("⚠️ Unknown stream output type")
            break
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) async {
        guard isCapturing && isStreaming else { return }
        
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let adjustedTime = presentationTime - firstSampleTime
        lastAudioTime = adjustedTime
        print("Microphone buffer for WebRTC, time: \(adjustedTime.seconds)")
        audioBufferCallback?(sampleBuffer)
        webrtcAudioCallback?(sampleBuffer)
    }

    func stopCapture() async throws {
        guard let stream = stream else {
            throw RecordingError("Stream not initialized")
        }

        isStreaming = false
        try await stream.stopCapture()
        
        if let session = captureSession {
            print("AVCaptureSession state before stop: \(session.isRunning)")
            session.stopRunning()
            print("Capture stopped")
        }

        try await Task.sleep(nanoseconds: 1_000_000_000)

        isCapturing = false
        self.stream = nil
        self.captureSession = nil
        firstSampleTime = .zero
        lastVideoTime = .zero
        lastAudioTime = .zero
        contentFilter = nil
    }

    func getAvailableSources() async throws -> [[String: Any]] {
        let contentTask = Task { @MainActor in
            try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        }
        let content = try await contentTask.value
        
        var sources: [[String: Any]] = []
        
        // Добавляем дисплеи
        for (i, display) in content.displays.enumerated() {
            sources.append([
                "type": "display",
                "id": "\(display.displayID)",
                "name": "Screen \(i + 1)",
                "width": display.width,
                "height": display.height
            ])
        }
        
        // Добавляем окна
        for window in content.windows {
            // Пропускаем слишком маленькие окна
            if window.frame.width < 10 || window.frame.height < 10 {
                continue
            }
            
            sources.append([
                "type": "window",
                "id": "\(window.windowID)",
                "name": "\(window.title ?? "Untitled") - \(window.owningApplication?.applicationName ?? "Unknown")",
                "appName": window.owningApplication?.applicationName ?? "Unknown",
                "title": window.title ?? "Untitled",
                "width": Int(window.frame.width),
                "height": Int(window.frame.height)
            ])
        }
        
        // Добавляем приложения
        for app in content.applications {
            sources.append([
                "type": "application",
                "id": app.bundleIdentifier,
                "name": app.applicationName,
                "bundleId": app.bundleIdentifier
            ])
        }
        
        return sources
    }

    func setDirectVideoCallback(_ callback: @escaping (CVImageBuffer, Double) -> Void) {
        // Сохраняем прямой callback для видео буфера
        self.directVideoCallback = callback
    }

    func setDirectAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        // Сохраняем прямой callback для аудио буфера
        self.directAudioCallback = callback
    }
}

@available(macOS 12.3, *)
class CaptureOutputDelegate: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    weak var actor: CaptureActor?

    override init() {
        super.init()
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        Task.detached { [weak actor = self.actor, error] in
            await actor?.handleStreamError(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        Task.detached { [weak actor = self.actor, stream, sampleBuffer, outputType] in
            await actor?.stream(stream, didOutputSampleBuffer: sampleBuffer, of: outputType)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        Task.detached { [weak actor = self.actor, output, sampleBuffer, connection] in
            await actor?.captureOutput(output, didOutput: sampleBuffer, from: connection)
        }
    }
}

@available(macOS 12.3, *)
@objc(CCaptureManager)
public class ScreenCaptureManager: NSObject, SCContentSharingPickerObserver {
    private let captureActor = CaptureActor()

    @objc public var isCapturing: Bool {
        get {
            let box = Box<Bool>(false)
            let semaphore = DispatchSemaphore(value: 0)
            Task.detached { [captureActor = self.captureActor] in
                box.value = await captureActor.isCapturing
                semaphore.signal()
            }
            semaphore.wait()
            return box.value
        }
    }

    @objc public var errorMessage: String? {
        get {
            let box = Box<String?>(nil)
            let semaphore = DispatchSemaphore(value: 0)
            Task.detached { [captureActor = self.captureActor] in
                box.value = await captureActor.errorMessage
                semaphore.signal()
            }
            semaphore.wait()
            return box.value
        }
    }

    @objc public func setCaptureSource(_ source: [String: Any], completion: @escaping @Sendable (NSError?) -> Void) {
        print("setCaptureSource called with source: \(source)")
        let type = source["type"] as! String
        let id = source["id"] as! String
        Task.detached { [captureActor = self.captureActor, type, id] in
            do {
                try await captureActor.setCaptureSource(type: type, id: id)
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("setCaptureSource error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func startCaptureWithCompletion(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("startCaptureWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                try await captureActor.startCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("startCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func stopCaptureWithCompletion(_ completion: @escaping @Sendable (NSError?) -> Void) {
        print("stopCaptureWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                try await captureActor.stopCapture()
                DispatchQueue.main.async {
                    completion(nil)
                }
            } catch {
                print("stopCapture error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError)
                }
            }
        }
    }

    @objc public func testMethod() {
        print("Test from ScreenCaptureManager")
    }

    @objc public func setVideoBufferCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setVideoCallback(callback)
        }
    }

    @objc public func setAudioBufferCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setAudioCallback(callback)
        }
    }
    
    @objc public func setWebRTCVideoCallback(_ callback: @escaping ([String: Any]) -> Void) {
        Task {
            await captureActor.setWebRTCVideoCallback(callback)
        }
    }
    
    @objc public func setWebRTCAudioCallback(_ callback: @escaping (CMSampleBuffer) -> Void) {
        Task {
            await captureActor.setWebRTCAudioCallback(callback)
        }
    }

    @objc public func getAvailableSourcesWithCompletion(_ completion: @escaping @Sendable (NSError?, [[String: Any]]?) -> Void) {
    print("getAvailableSourcesWithCompletion called")
        Task.detached { [captureActor = self.captureActor] in
            do {
                let sources = try await captureActor.getAvailableSources()
                DispatchQueue.main.async {
                    completion(nil, sources)
                }
            } catch {
                print("getAvailableSources error: \(error)")
                DispatchQueue.main.async {
                    completion(error as NSError, nil)
                }
            }
        }
    }

    @available(macOS 14.0, *)
    @objc public func selectSourceWithPickerWithCompletion(_ completion: @escaping @Sendable (NSError?, [String: Any]?) -> Void) {
        Task.detached { [captureActor = self.captureActor] in
            await captureActor.setPickerCompletion(completion)
            let picker = SCContentSharingPicker.shared
            await MainActor.run { [weak self] in
                guard let self = self else { return }
                picker.add(self)
                picker.isActive = true
            }
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        print("contentSharingPicker didUpdateWith filter")
        picker.remove(self)
        picker.isActive = false
        Task.detached { [captureActor = self.captureActor, filter] in
            let completion = await captureActor.getPickerCompletion()
            do {
                print("Fetching SCShareableContent.current")
                let content = try await SCShareableContent.current
                var source: [String: Any]?
                for window in content.windows {
                    let testFilter = SCContentFilter(desktopIndependentWindow: window)
                    if testFilter == filter {
                        source = ["type": "window", "id": "\(window.windowID)"]
                        break
                    }
                }
                if source == nil {
                    for display in content.displays {
                        let testFilter = SCContentFilter(display: display, excludingWindows: [])
                        if testFilter == filter {
                            source = ["type": "display", "id": "\(display.displayID)"]
                            break
                        }
                    }
                }
                print("Source found: \(source ?? [:])")
                let strongSource = source
                DispatchQueue.main.async {
                    completion?(nil, strongSource)
                }
            } catch {
                DispatchQueue.main.async {
                    completion?(error as NSError, nil)
                }
            }
            await captureActor.clearPickerCompletion()
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        print("contentSharingPicker didCancel")
        picker.remove(self)
        picker.isActive = false
        Task.detached { [captureActor = self.captureActor] in
            let completion = await captureActor.getPickerCompletion()
            DispatchQueue.main.async {
                completion?(NSError(domain: "Cancelled", code: 2), nil)
            }
            await captureActor.clearPickerCompletion()
        }
    }

    @available(macOS 14.0, *)
    public func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        print("contentSharingPickerStartDidFailWithError: \(error)")
        Task.detached { [captureActor = self.captureActor] in
            let completion = await captureActor.getPickerCompletion()
            DispatchQueue.main.async {
                completion?(error as NSError, nil)
            }
            await captureActor.clearPickerCompletion()
        }
    }
}

class RecordingError: NSError, @unchecked Sendable {
    init(_ message: String) {
        super.init(domain: "RecordingDomain", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

// Fix Sendable conformances
extension SCShareableContent: @retroactive @unchecked Sendable {}
extension SCDisplay: @retroactive @unchecked Sendable {}
extension SCWindow: @retroactive @unchecked Sendable {}
extension SCRunningApplication: @retroactive @unchecked Sendable {}
extension CMSampleBuffer: @retroactive @unchecked Sendable {}
extension SCStream: @retroactive @unchecked Sendable {}
extension AVCaptureOutput: @retroactive @unchecked Sendable {}
extension AVCaptureConnection: @retroactive @unchecked Sendable {}
extension SCContentFilter: @retroactive @unchecked Sendable {}
